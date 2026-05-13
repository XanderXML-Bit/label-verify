import { describe, it, expect } from "vitest";
import {
  parseApplication,
  ApplicationParseError,
} from "@/lib/application/parse";
import { parseApplicationText } from "@/lib/application/parse-text";
import {
  parseApplicationJson,
  parseApplicationCsv,
} from "@/lib/application/parse-structured";

const FULL_TXT = `
Brand Name: Stone's Throw IPA
Class / Type: India Pale Ale
Class Category: beer
ABV: 6.4%
Net Contents: 12 fl oz
Producer: Stone Brewing Co., San Diego, CA
Country of Origin: USA
`;

const MARKDOWN_FORMATTED = `
**Brand Name:** Stone's Throw IPA
**Class / Type:** \`India Pale Ale\`
**Class Category:** beer
**ABV:** 6.4%
**Net Contents:** 12 fl oz
**Producer:** Stone Brewing Co., San Diego, CA
**Country of Origin:** USA
`;

const KV_TXT_MISSING_FIELDS = `
Brand: Mystery Lager
ABV: 4.5%
`;

const KV_JSON = JSON.stringify({
  brand_name: "Stone's Throw IPA",
  class_type: "India Pale Ale",
  class_category: "beer",
  abv_percent: 6.4,
  net_contents: { value: 12, unit: "fl_oz" },
  producer: "Stone Brewing Co., San Diego, CA",
  country_of_origin: "USA",
});

const KV_CSV = `brand_name,class_type,class_category,abv_percent,net_contents,producer,country_of_origin
Stone's Throw IPA,India Pale Ale,beer,6.4,12 fl_oz,Stone Brewing Co.,USA`;

describe("application/parse-text", () => {
  it("extracts seven fields from a TTB-style application paragraph", () => {
    const r = parseApplicationText(FULL_TXT);
    expect(r.fields.brand_name).toBe("Stone's Throw IPA");
    expect(r.fields.class_type).toBe("India Pale Ale");
    expect(r.fields.class_category).toBe("beer");
    expect(r.fields.abv_percent).toBe(6.4);
    expect(r.fields.net_contents).toEqual({ value: 12, unit: "fl_oz" });
    expect(r.fields.producer).toBe("Stone Brewing Co., San Diego, CA");
    expect(r.fields.country_of_origin).toBe("USA");
    expect(r.warnings).toEqual([]);
  });

  it("strips markdown emphasis + backticks before regex-parsing", () => {
    const r = parseApplicationText(MARKDOWN_FORMATTED);
    expect(r.fields.brand_name).toBe("Stone's Throw IPA");
    expect(r.fields.class_type).toBe("India Pale Ale");
    expect(r.fields.abv_percent).toBe(6.4);
  });

  it("warns when only a partial set of fields is recognised", () => {
    const r = parseApplicationText(KV_TXT_MISSING_FIELDS);
    expect(r.fields.brand_name).toBe("Mystery Lager");
    expect(r.fields.abv_percent).toBe(4.5);
    expect(r.warnings.length).toBe(1);
    expect(r.warnings[0]).toMatch(/Parsed 2 of 7 fields/);
  });

  it("returns a warning when no fields can be extracted", () => {
    const r = parseApplicationText("nothing structured here at all");
    // country_of_origin: null is always emitted (US-domestic-omission
    // semantics — see src/lib/application/row-to-declared.ts). All
    // other fields stay undefined when nothing structured was found.
    const parsedKeys = Object.keys(r.fields).filter(
      (k) =>
        (r.fields as Record<string, unknown>)[k] !== undefined &&
        k !== "country_of_origin",
    );
    expect(parsedKeys).toEqual([]);
    expect(r.warnings[0]).toMatch(/No application fields recognised/);
  });

  it("handles markdown tables", () => {
    const table = `
| Field | Value |
| --- | --- |
| Brand Name | Quiet Bourbon |
| Class / Type | Bourbon Whiskey |
| Class Category | distilled_spirits |
| ABV | 50.0 |
| Net Contents | 750 ml |
| Producer | Quiet Distillery, Frankfort, KY |
| Country of Origin | USA |
`;
    const r = parseApplicationText(table);
    expect(r.fields.brand_name).toBe("Quiet Bourbon");
    expect(r.fields.class_category).toBe("distilled_spirits");
    expect(r.fields.abv_percent).toBe(50);
    expect(r.fields.net_contents).toEqual({ value: 750, unit: "ml" });
  });
});

describe("application/parse-structured", () => {
  it("parses a complete JSON record", () => {
    const r = parseApplicationJson(KV_JSON);
    expect(r.fields.brand_name).toBe("Stone's Throw IPA");
    expect(r.fields.net_contents).toEqual({ value: 12, unit: "fl_oz" });
  });

  it("flags multi-row JSON arrays and uses the first row", () => {
    const arr = JSON.stringify([
      { brand_name: "A", abv_percent: 5 },
      { brand_name: "B", abv_percent: 6 },
    ]);
    const r = parseApplicationJson(arr);
    expect(r.fields.brand_name).toBe("A");
    expect(r.warnings[0]).toMatch(/2 rows; using the first/);
  });

  it("parses a single-row CSV via the manifest aliases", () => {
    const r = parseApplicationCsv(KV_CSV);
    expect(r.fields.brand_name).toBe("Stone's Throw IPA");
    expect(r.fields.class_category).toBe("beer");
    expect(r.fields.net_contents).toEqual({ value: 12, unit: "fl_oz" });
  });

  it("rejects an empty CSV", () => {
    expect(() => parseApplicationCsv("")).toThrow(/empty|parse/i);
  });
});

describe("application/parse (dispatcher)", () => {
  it("routes JSON by MIME", async () => {
    const r = await parseApplication({
      buffer: Buffer.from(KV_JSON, "utf8"),
      filename: "app.json",
      mime: "application/json",
    });
    expect(r.source).toBe("json");
    expect(r.fields.brand_name).toBe("Stone's Throw IPA");
    expect(r.confidence).toBe("high");
  });

  it("routes CSV by extension when MIME is generic", async () => {
    const r = await parseApplication({
      buffer: Buffer.from(KV_CSV, "utf8"),
      filename: "app.csv",
      mime: "application/octet-stream",
    });
    expect(r.source).toBe("csv");
    expect(r.fields.brand_name).toBe("Stone's Throw IPA");
  });

  it("routes plain text", async () => {
    const r = await parseApplication({
      buffer: Buffer.from(FULL_TXT, "utf8"),
      filename: "app.txt",
      mime: "text/plain",
    });
    expect(r.source).toBe("txt");
    expect(r.fields.brand_name).toBe("Stone's Throw IPA");
  });

  it("routes markdown", async () => {
    const r = await parseApplication({
      buffer: Buffer.from(MARKDOWN_FORMATTED, "utf8"),
      filename: "app.md",
      mime: "text/markdown",
    });
    expect(r.source).toBe("md");
    expect(r.fields.brand_name).toBe("Stone's Throw IPA");
  });

  it("rejects unsupported MIME with a 415", async () => {
    await expect(
      parseApplication({
        buffer: Buffer.from("hello"),
        filename: "app.wav",
        mime: "audio/wav",
      }),
    ).rejects.toMatchObject({ code: "unsupported-mime", status: 415 });
  });

  it("dispatches DOCX to the mammoth-backed parser", async () => {
    // Bare "docx contents" bytes aren't a valid OOXML zip, so mammoth
    // will reject. The point of this test is that the DISPATCH now
    // routes DOCX to the DOCX parser (previously failed with an
    // explicit "DOCX upload is not yet supported" message). The
    // mammoth-emitted error makes it through as a parse-failed code.
    await expect(
      parseApplication({
        buffer: Buffer.from("docx contents"),
        filename: "app.docx",
        mime:
          "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
      }),
    ).rejects.toMatchObject({ code: "parse-failed" });
  });

  it("rejects an empty buffer", async () => {
    await expect(
      parseApplication({
        buffer: Buffer.from(""),
        filename: "empty.txt",
        mime: "text/plain",
      }),
    ).rejects.toMatchObject({ code: "empty" });
  });

  it("flags image MIME as needing the vision path", async () => {
    await expect(
      parseApplication({
        buffer: Buffer.from([0xff, 0xd8, 0xff]),
        filename: "form.jpg",
        mime: "image/jpeg",
      }),
    ).rejects.toMatchObject({ code: "vision-unavailable" });
  });
});

describe("ApplicationParseError instances are well-formed", () => {
  it("captures status code", () => {
    const e = new ApplicationParseError("too-large", "too big", 413);
    expect(e.status).toBe(413);
    expect(e.code).toBe("too-large");
    expect(e.name).toBe("ApplicationParseError");
  });
});
