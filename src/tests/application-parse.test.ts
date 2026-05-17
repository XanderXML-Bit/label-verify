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

  // ─── filename-keyed multi-row JSON manifest (user's batch shape) ────────
  //
  // The user-reported failure: when an image + an application-data.json
  // shaped as `{"label-001.jpg": {row}, "label-002.jpg": {row}, ...}`
  // are uploaded together, the parser must (a) recognise the filename-
  // keyed shape and (b) pick the row matching the uploaded image rather
  // than flattening the whole map into a single garbage record.
  it("picks the row matching imageFilename in a filename-keyed JSON map", () => {
    const text = JSON.stringify({
      "ai-label-0001.jpg": {
        fields: {
          brand_name: "Mill Creek",
          class_type: "Pilsner",
          class_category: "beer",
          abv_percent: 5.2,
          net_contents: { value: 12, unit: "fl_oz" },
        },
      },
      "ai-label-0005.jpg": {
        fields: {
          brand_name: "Latitude Seven",
          class_type: "IPA",
          class_category: "beer",
          abv_percent: 6.4,
          net_contents: { value: 12, unit: "fl_oz" },
        },
      },
    });
    const r = parseApplicationJson(text, {
      imageFilename: "ai-label-0005.jpg",
    });
    expect(r.fields.brand_name).toBe("Latitude Seven");
    expect(r.fields.class_type).toBe("IPA");
    expect(r.warnings).toEqual([]);
  });

  it("matches by filename stem when extensions differ", () => {
    const text = JSON.stringify({
      "deg-beer-0001.png": {
        fields: { brand_name: "Cold Iron", class_type: "Saison", abv_percent: 7.5 },
      },
    });
    // The actual image might be uploaded as .jpg but the manifest
    // tracked the original .png — match by stem.
    const r = parseApplicationJson(text, {
      imageFilename: "deg-beer-0001.jpg",
    });
    expect(r.fields.brand_name).toBe("Cold Iron");
  });

  it("warns and uses first row when imageFilename has no match in the manifest", () => {
    const text = JSON.stringify({
      "label-001.jpg": { brand_name: "A", abv_percent: 5 },
      "label-002.jpg": { brand_name: "B", abv_percent: 6 },
    });
    const r = parseApplicationJson(text, {
      imageFilename: "totally-different.jpg",
    });
    expect(r.fields.brand_name).toBe("A");
    expect(r.warnings[0]).toMatch(/none matched image/);
  });

  it("warns when multi-row JSON has no imageFilename context", () => {
    const text = JSON.stringify({
      "label-001.jpg": { brand_name: "A", abv_percent: 5 },
      "label-002.jpg": { brand_name: "B", abv_percent: 6 },
    });
    const r = parseApplicationJson(text);
    expect(r.fields.brand_name).toBe("A");
    expect(r.warnings[0]).toMatch(/2 rows; using the first/);
  });

  it("CSV picks the row matching imageFilename when a `filename` column is present", () => {
    const csv =
      "filename,brand_name,class_type,abv_percent\n" +
      "label-001.jpg,A,IPA,5\n" +
      "label-002.jpg,B,Pilsner,6\n" +
      "label-003.jpg,C,Stout,7\n";
    const r = parseApplicationCsv(csv, {
      imageFilename: "label-002.jpg",
    });
    expect(r.fields.brand_name).toBe("B");
    expect(r.fields.class_type).toBe("Pilsner");
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

  // Wave-33 coverage push: parse.ts was at 62 % on main. The dispatcher
  // has 8 source paths (pdf-text / pdf-vision-fallback / json / docx /
  // csv / md / txt / image-reject); the existing tests covered ~5 of
  // them. Adding the remaining edge-case + format-routing tests.
  it("routes markdown by extension when MIME is generic", async () => {
    const r = await parseApplication({
      buffer: Buffer.from(
        "Brand: TestBrew\nClass: IPA\nABV: 6.4%\nNet: 12 fl oz\n",
      ),
      filename: "app.md",
      mime: "application/octet-stream", // generic; ext wins
    });
    expect(r.source).toBe("md");
    expect(r.fields.brand_name).toBe("TestBrew");
  });

  it("routes plain text via text/* MIME family", async () => {
    const r = await parseApplication({
      buffer: Buffer.from(
        "Brand: TestBrew\nClass: IPA\nABV: 6.4%\nNet: 12 fl oz",
      ),
      filename: "app.txt",
      mime: "text/plain",
    });
    expect(r.source).toBe("txt");
  });

  it("rejects oversize input (too-large) with HTTP 413", async () => {
    const huge = Buffer.alloc(11 * 1024 * 1024, 0x20);
    await expect(
      parseApplication({
        buffer: huge,
        filename: "app.txt",
        mime: "text/plain",
      }),
    ).rejects.toMatchObject({ code: "too-large", status: 413 });
  });

  it("rejects unknown MIME and unknown extension as unsupported-mime", async () => {
    await expect(
      parseApplication({
        buffer: Buffer.from("hello"),
        filename: "app.unknown",
        mime: "application/x-strange",
      }),
    ).rejects.toMatchObject({ code: "unsupported-mime", status: 415 });
  });

  it("falls back to vision when a PDF has no extractable text (no API key → fails closed)", async () => {
    // The minimal PDF we craft has an empty content stream → 0 extractable text.
    // Without args.apiKey, the dispatcher must error rather than silently pass.
    const objects = [
      "1 0 obj\n<< /Type /Catalog /Pages 2 0 R >>\nendobj\n",
      "2 0 obj\n<< /Type /Pages /Kids [3 0 R] /Count 1 >>\nendobj\n",
      "3 0 obj\n<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Resources << >> /Contents 4 0 R >>\nendobj\n",
      "4 0 obj\n<< /Length 8 >>\nstream\nBT ET\n\nendstream\nendobj\n",
    ];
    let body = "%PDF-1.4\n%\xC2\xA5\xC2\xB1\xC3\xAB\n";
    const offsets: number[] = [];
    for (const obj of objects) {
      offsets.push(Buffer.byteLength(body, "binary"));
      body += obj;
    }
    const xrefStart = Buffer.byteLength(body, "binary");
    body += "xref\n0 5\n0000000000 65535 f \n";
    for (const off of offsets) {
      body += `${off.toString().padStart(10, "0")} 00000 n \n`;
    }
    body += `trailer\n<< /Size 5 /Root 1 0 R >>\nstartxref\n${xrefStart}\n%%EOF\n`;
    const emptyPdf = Buffer.from(body, "binary");
    await expect(
      parseApplication({
        buffer: emptyPdf,
        filename: "scan.pdf",
        mime: "application/pdf",
        // no apiKey
      }),
    ).rejects.toMatchObject({ code: "parse-failed" });
  });

  it("uses ext-only routing when MIME is empty", async () => {
    const r = await parseApplication({
      buffer: Buffer.from('{"brand_name":"X"}'),
      filename: "app.json",
      mime: "",
    });
    expect(r.source).toBe("json");
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
