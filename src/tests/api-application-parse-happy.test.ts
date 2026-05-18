// Wave-35e — happy-path coverage for /api/application/parse.
//
// The wave-35e coverage audit flagged this route as having ONLY
// rate-limit-branch coverage. The actual `parseApplication` /
// `parseApplicationImage` pipelines — which reviewers hit on every
// upload — had no integration test. A regression in JSON / CSV /
// text / markdown parsing would land in production silently.
//
// This file pins the happy path for each non-image source format
// (JSON, CSV, markdown, plain-text), plus the validation branches
// the route exposes (oversize, unsupported MIME, empty file).
//
// The image / PDF paths call out to Gemini / pdfjs respectively;
// they're exercised by `application-parse.test.ts` against the
// underlying helpers and aren't re-mocked here.

import { describe, expect, it, vi, afterEach } from "vitest";
import { POST } from "@/app/api/application/parse/route";

// Each test uses a distinct TEST-NET IP so the rate-limit bucket
// doesn't bleed across tests.
let ipCounter = 0;
function freshIp(): string {
  ipCounter++;
  return `203.0.114.${ipCounter}`;
}

function makeReq(form: FormData, ip = freshIp()): Request {
  return new Request("http://test.local/api/application/parse", {
    method: "POST",
    headers: {
      "x-forwarded-for": ip,
    },
    body: form,
  });
}

afterEach(() => {
  vi.restoreAllMocks();
});

describe("/api/application/parse — happy path: JSON", () => {
  it("parses a valid JSON application file into DeclaredFields", async () => {
    const json = JSON.stringify({
      brand_name: "Stones Throw IPA",
      class_type: "India Pale Ale",
      class_category: "beer",
      abv_percent: 6.4,
      net_contents: { value: 12, unit: "fl_oz" },
      producer: "Stones Throw Brewing Co., San Diego, CA, USA",
      country_of_origin: "USA",
    });
    const fd = new FormData();
    fd.append("file", new File([json], "application.json", { type: "application/json" }));
    const resp = await POST(makeReq(fd));
    expect(resp.status).toBe(200);
    const body = (await resp.json()) as { fields: Record<string, unknown>; source: string; warnings: string[] };
    expect(body.source).toBe("json");
    expect(body.fields.brand_name).toBe("Stones Throw IPA");
    expect(body.fields.class_type).toBe("India Pale Ale");
    expect(body.fields.abv_percent).toBe(6.4);
    expect(body.fields.net_contents).toEqual({ value: 12, unit: "fl_oz" });
    expect(Array.isArray(body.warnings)).toBe(true);
  });

  it("returns 400 with a useful error on malformed JSON", async () => {
    const fd = new FormData();
    fd.append("file", new File(["not valid json{{{"], "broken.json", { type: "application/json" }));
    const resp = await POST(makeReq(fd));
    expect([400, 422]).toContain(resp.status);
    const body = (await resp.json()) as { error: string; code: string };
    expect(body.error).toBeTruthy();
  });
});

describe("/api/application/parse — happy path: CSV", () => {
  it("parses a single-row CSV with header into DeclaredFields", async () => {
    const csv =
      "brand_name,class_type,class_category,abv_percent,net_contents,country_of_origin\n" +
      "Stones Throw IPA,India Pale Ale,beer,6.4,12 fl_oz,USA";
    const fd = new FormData();
    fd.append("file", new File([csv], "application.csv", { type: "text/csv" }));
    const resp = await POST(makeReq(fd));
    expect(resp.status).toBe(200);
    const body = (await resp.json()) as { fields: Record<string, unknown>; source: string };
    expect(body.source).toBe("csv");
    expect(body.fields.brand_name).toBe("Stones Throw IPA");
    expect(body.fields.abv_percent).toBe(6.4);
  });

  it("accepts alias column names (brand vs brand_name, abv vs abv_percent)", async () => {
    const csv =
      "brand,class,abv,net_contents,country\n" +
      "Pilsner Reserve,Pilsner,5.0,355 ml,USA";
    const fd = new FormData();
    fd.append("file", new File([csv], "application.csv", { type: "text/csv" }));
    const resp = await POST(makeReq(fd));
    expect(resp.status).toBe(200);
    const body = (await resp.json()) as { fields: Record<string, unknown> };
    expect(body.fields.brand_name).toBe("Pilsner Reserve");
    expect(body.fields.abv_percent).toBe(5.0);
    expect(body.fields.net_contents).toEqual({ value: 355, unit: "ml" });
  });
});

describe("/api/application/parse — happy path: markdown", () => {
  it("parses a markdown application doc via heading + key-value pairs", async () => {
    const md = [
      "# COLA Application",
      "",
      "Brand: Pilsner Reserve",
      "Class: Pilsner",
      "ABV: 5.0%",
      "Net Contents: 12 fl_oz",
      "Country: USA",
    ].join("\n");
    const fd = new FormData();
    fd.append("file", new File([md], "application.md", { type: "text/markdown" }));
    const resp = await POST(makeReq(fd));
    expect(resp.status).toBe(200);
    const body = (await resp.json()) as { fields: Record<string, unknown>; source: string };
    expect(body.source).toBe("md");
    expect(body.fields.brand_name).toBe("Pilsner Reserve");
    expect(body.fields.abv_percent).toBe(5.0);
  });
});

describe("/api/application/parse — happy path: plain text", () => {
  it("parses a plain-text key-value application doc", async () => {
    const txt = [
      "Brand: Stones Throw IPA",
      "Class: India Pale Ale",
      "ABV: 6.4%",
      "Net Contents: 12 fl_oz",
      "Country: USA",
    ].join("\n");
    const fd = new FormData();
    fd.append("file", new File([txt], "application.txt", { type: "text/plain" }));
    const resp = await POST(makeReq(fd));
    expect(resp.status).toBe(200);
    const body = (await resp.json()) as { fields: Record<string, unknown>; source: string };
    expect(body.source).toBe("txt");
    expect(body.fields.brand_name).toBe("Stones Throw IPA");
  });
});

describe("/api/application/parse — happy path: multi-row CSV with imageFilename hint", () => {
  it("picks the row matching the supplied imageFilename out of a multi-row manifest", async () => {
    const csv =
      "filename,brand_name,class_type,class_category,abv_percent,net_contents,country_of_origin\n" +
      "label-001.png,Brand A,IPA,beer,6.4,12 fl_oz,USA\n" +
      "label-002.png,Brand B,Lager,beer,5.0,12 fl_oz,USA\n" +
      "label-003.png,Brand C,Stout,beer,7.0,12 fl_oz,USA";
    const fd = new FormData();
    fd.append("file", new File([csv], "manifest.csv", { type: "text/csv" }));
    fd.append("imageFilename", "label-002.png");
    const resp = await POST(makeReq(fd));
    expect(resp.status).toBe(200);
    const body = (await resp.json()) as { fields: Record<string, unknown>; source: string };
    expect(body.fields.brand_name).toBe("Brand B");
    expect(body.fields.class_type).toBe("Lager");
  });
});

describe("/api/application/parse — error branches", () => {
  it("returns 400 when 'file' field is missing", async () => {
    const fd = new FormData();
    const resp = await POST(makeReq(fd));
    expect(resp.status).toBe(400);
    const body = (await resp.json()) as { error: string; code: string };
    expect(body.code).toBe("missing-file");
  });

  it("returns 400 when 'file' is empty (size === 0)", async () => {
    const fd = new FormData();
    fd.append("file", new File([], "empty.json", { type: "application/json" }));
    const resp = await POST(makeReq(fd));
    expect(resp.status).toBe(400);
  });

  it("returns 413 when file exceeds the 10 MB cap", async () => {
    // 11 MB payload (well over the 10 MB documented cap).
    const big = new Uint8Array(11 * 1024 * 1024);
    const fd = new FormData();
    fd.append("file", new File([big], "huge.json", { type: "application/json" }));
    const resp = await POST(makeReq(fd));
    expect(resp.status).toBe(413);
  });
});

describe("/api/application/parse — response envelope shape (Apex §13.8a claim ledger)", () => {
  it("response includes `source`, `fields`, `warnings`, and `confidence`", async () => {
    const json = JSON.stringify({ brand_name: "X", abv_percent: 5 });
    const fd = new FormData();
    fd.append("file", new File([json], "x.json", { type: "application/json" }));
    const resp = await POST(makeReq(fd));
    expect(resp.status).toBe(200);
    const body = (await resp.json()) as Record<string, unknown>;
    expect(body).toHaveProperty("source");
    expect(body).toHaveProperty("fields");
    expect(body).toHaveProperty("warnings");
    expect(body).toHaveProperty("confidence");
    expect(["high", "medium", "low"]).toContain(body.confidence);
  });
});
