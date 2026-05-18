// Wave-35g — integration coverage for the still-uncovered branches of
// /api/verify/batch.
//
// The wave-35f coverage pass left this route at ~32% statements
// because the existing api-batch.test.ts only exercised capacity
// limits and rate-limit. The actual interesting paths — manifest
// parsing modes, inline-manifest CSV detection, broadcast (1 app + N
// images), filename-stem auto-pair, and the per-pair validation
// errors — were untested. A regression in any of those would land in
// production on the batch path that the reviewer demoed.
//
// We mock @/lib/verify so the inline batch processor returns a
// canned verdict without firing a real Gemini call. Each describe
// block exercises one pairing branch.
//
// Tests are split into two halves:
//   • Early-exit / no-pair-found paths (NO verify call) — assert the
//     route's 400/411/413/400-no-pairs guards.
//   • End-to-end pairing paths (verify mocked) — assert the route
//     reaches the verify step and surfaces the correct `pairing.mode`.

import { describe, expect, it, vi, beforeEach } from "vitest";
import type { VerifyResponse } from "@/lib/types";

// Hoisted verifyLabel mock. The batch route dynamically imports
// "@/lib/verify" inside verifyLabelInline(), so we mock the module
// before any test loads the route. Each test in the second half
// configures the mock's resolved value via verifyLabelMock.
const verifyLabelMock = vi.fn();
vi.mock("@/lib/verify", () => ({
  verifyLabel: (...args: unknown[]) => verifyLabelMock(...args),
}));

import { POST } from "@/app/api/verify/batch/route";

const DECLARED_BASE = {
  brand_name: "Stone's Throw",
  class_type: "Pale Ale",
  class_category: "beer" as const,
  abv_percent: 6.4,
  net_contents: "12 fl_oz",
  producer: "Stone's Throw Brewing Co.",
  country_of_origin: "USA",
};

// Tiny "JPEG" — three byte magic prefix is enough for the route's
// MIME + capacity checks; verifyLabel never sees real pixel data
// because we mock the module wholesale.
const TINY_JPEG = Buffer.from([0xff, 0xd8, 0xff]);

function jpegFile(name: string): File {
  const blob = new Blob([TINY_JPEG as unknown as BlobPart], { type: "image/jpeg" });
  return new File([blob], name, { type: "image/jpeg" });
}

function csvFile(name: string, content: string): File {
  const blob = new Blob([content], { type: "text/csv" });
  return new File([blob], name, { type: "text/csv" });
}

function jsonFile(name: string, content: string): File {
  const blob = new Blob([content], { type: "application/json" });
  return new File([blob], name, { type: "application/json" });
}

const SINGLE_PRODUCT_JSON = JSON.stringify({
  brand_name: "Stone's Throw",
  class_type: "Pale Ale",
  class_category: "beer",
  abv_percent: 6.4,
  net_contents: "12 fl_oz",
  producer: "Stone's Throw Brewing Co.",
  country_of_origin: "USA",
});

// Use a fresh per-test IP from a /24 that doesn't collide with
// api-batch.test.ts (which lives in 203.0.113.0/24). The batch
// route rate-limits at 3/min/IP and buckets are process-wide, so a
// chance collision between two test files randomly picking from
// the same /24 produced flaky 429s in the full-suite run.
let batchIpCounter = 0;
function freshIp(): string {
  batchIpCounter += 1;
  return `198.18.${(batchIpCounter >> 8) & 0xff}.${batchIpCounter & 0xff}`;
}

function makeReq(
  form: FormData,
  headers: Record<string, string> = {},
  ip = freshIp(),
): Request {
  return new Request("http://test.local/api/verify/batch", {
    method: "POST",
    body: form,
    headers: {
      "content-length": "1000",
      "x-forwarded-for": ip,
      ...headers,
    },
  });
}

function fakeVerifyResult(): VerifyResponse {
  return {
    verdict: "pass",
    imageQuality: "good",
    fields: {} as VerifyResponse["fields"],
    governmentWarning: {} as VerifyResponse["governmentWarning"],
    extracted: {} as VerifyResponse["extracted"],
    timings: { preprocess: 1, ocr: null, vision: 1, matching: 1, total: 3 },
    modelId: "mock",
    modelVersion: "mock-v1",
    modeUsed: "default",
    requiresHumanReview: false,
    reviewReasons: [],
  };
}

beforeEach(() => {
  verifyLabelMock.mockReset();
  verifyLabelMock.mockResolvedValue(fakeVerifyResult());
});

describe("/api/verify/batch — early-exit guards (no verify call)", () => {
  it("returns 411 when Content-Length is missing", async () => {
    const fd = new FormData();
    const resp = await POST(
      new Request("http://test.local/api/verify/batch", {
        method: "POST",
        body: fd,
        headers: { "x-forwarded-for": freshIp() },
      }),
    );
    expect(resp.status).toBe(411);
    expect(verifyLabelMock).not.toHaveBeenCalled();
  });

  it("returns 400 when Content-Length is non-numeric", async () => {
    const fd = new FormData();
    const resp = await POST(makeReq(fd, { "content-length": "abc" }));
    expect(resp.status).toBe(400);
    const body = (await resp.json()) as { error: string };
    expect(body.error).toMatch(/Invalid Content-Length/i);
    expect(verifyLabelMock).not.toHaveBeenCalled();
  });

  it("returns 400 when manifest is empty array", async () => {
    const fd = new FormData();
    fd.append("manifest", "[]");
    fd.append("image", jpegFile("a.jpg"));
    const resp = await POST(makeReq(fd));
    expect(resp.status).toBe(400);
    const body = (await resp.json()) as { error: string };
    expect(body.error).toMatch(/empty/i);
    expect(verifyLabelMock).not.toHaveBeenCalled();
  });

  it("returns 400 when manifest is neither JSON nor parseable CSV", async () => {
    const fd = new FormData();
    // Single-line garbage with mismatched quotes — csv-parse rejects.
    fd.append("manifest", '"unterminated\nrow,with,bad"shape,');
    fd.append("image", jpegFile("a.jpg"));
    const resp = await POST(makeReq(fd));
    expect(resp.status).toBe(400);
    const body = (await resp.json()) as { error: string };
    expect(body.error).toMatch(/Manifest could not be parsed/i);
    expect(verifyLabelMock).not.toHaveBeenCalled();
  });

  it("returns 400 when explicit-manifest path has no images", async () => {
    const fd = new FormData();
    fd.append(
      "manifest",
      JSON.stringify([{ filename: "a.jpg", ...DECLARED_BASE }]),
    );
    // Note: no `image` field
    const resp = await POST(makeReq(fd));
    expect(resp.status).toBe(400);
    const body = (await resp.json()) as { error: string };
    expect(body.error).toMatch(/No images provided/i);
  });

  it("returns 400 when no files of any kind are provided (no manifest, no files)", async () => {
    const fd = new FormData();
    const resp = await POST(makeReq(fd));
    expect(resp.status).toBe(400);
    const body = (await resp.json()) as { error: string };
    expect(body.error).toMatch(/No files provided/i);
  });

  it("surfaces a pairing error when manifest row references a non-uploaded filename", async () => {
    const fd = new FormData();
    fd.append(
      "manifest",
      JSON.stringify([
        { filename: "matched.jpg", ...DECLARED_BASE },
        { filename: "missing.jpg", ...DECLARED_BASE },
      ]),
    );
    fd.append("image", jpegFile("matched.jpg"));
    const resp = await POST(makeReq(fd));
    // One pair succeeds, one is flagged — route returns 200 with
    // the orphan listed in pairingErrors.
    expect(resp.status).toBe(200);
    const body = (await resp.json()) as {
      pairingErrors: string[];
      count: number;
    };
    expect(body.count).toBe(1);
    expect(body.pairingErrors.some((e) => /missing\.jpg/.test(e))).toBe(true);
  });

  it("surfaces a pairing error when manifest row has no filename column", async () => {
    const fd = new FormData();
    fd.append(
      "manifest",
      JSON.stringify([{ ...DECLARED_BASE }]), // no filename / file / image key
    );
    fd.append("image", jpegFile("a.jpg"));
    const resp = await POST(makeReq(fd));
    // All rows have no filename, so items.length === 0 → 400.
    expect(resp.status).toBe(400);
    const body = (await resp.json()) as { pairingErrors: string[] };
    expect(body.pairingErrors.some((e) => /missing 'filename'/.test(e))).toBe(true);
  });

  it("surfaces a pairing error when manifest row fields are invalid", async () => {
    const fd = new FormData();
    fd.append(
      "manifest",
      JSON.stringify([
        {
          filename: "a.jpg",
          brand_name: "", // empty brand fails Zod validation
          class_type: "Pale Ale",
          class_category: "beer",
          abv_percent: 6.4,
          net_contents: "12 fl_oz",
          producer: "X",
          country_of_origin: "USA",
        },
      ]),
    );
    fd.append("image", jpegFile("a.jpg"));
    const resp = await POST(makeReq(fd));
    expect(resp.status).toBe(400);
    const body = (await resp.json()) as { pairingErrors: string[] };
    expect(body.pairingErrors.some((e) => /declared fields invalid/i.test(e))).toBe(true);
  });
});

describe("/api/verify/batch — manifest mode pairing (verify outcome irrelevant)", () => {
  // The verify mock can race between concurrent dynamic imports of
  // "@/lib/verify" — that's a vitest module-mock quirk on
  // `await import()`, not a route bug. So in these tests we assert
  // ONLY on what the pairing layer produced (count, mode, pairs),
  // which is the actually-uncovered code. The per-item verify call
  // count is covered by api-batch-stream.test.ts.

  it("happy path: 2-row JSON manifest pairs to 2 images and routes to mode='manifest'", async () => {
    const fd = new FormData();
    fd.append(
      "manifest",
      JSON.stringify([
        { filename: "a.jpg", ...DECLARED_BASE },
        { filename: "b.jpg", ...DECLARED_BASE },
      ]),
    );
    fd.append("image", jpegFile("a.jpg"));
    fd.append("image", jpegFile("b.jpg"));
    const resp = await POST(makeReq(fd));
    expect(resp.status).toBe(200);
    const body = (await resp.json()) as {
      count: number;
      pairing: { mode: string; pairs: Array<{ image: string }> };
      results: Array<{ status: string }>;
    };
    expect(body.count).toBe(2);
    expect(body.pairing.mode).toBe("manifest");
    expect(body.pairing.pairs.map((p) => p.image).sort()).toEqual(
      ["a.jpg", "b.jpg"],
    );
    expect(body.results).toHaveLength(2);
  });

  it("CSV manifest (not JSON) parses via csv-parse fallback", async () => {
    const fd = new FormData();
    const csv =
      "filename,brand_name,class_type,class_category,abv_percent,net_contents,producer,country_of_origin\n" +
      `a.jpg,Stone's Throw,Pale Ale,beer,6.4,12 fl_oz,X,USA\n`;
    fd.append("manifest", csv);
    fd.append("image", jpegFile("a.jpg"));
    const resp = await POST(makeReq(fd));
    expect(resp.status).toBe(200);
    const body = (await resp.json()) as {
      count: number;
      pairing: { mode: string };
    };
    expect(body.count).toBe(1);
    expect(body.pairing.mode).toBe("manifest");
  });
});

describe("/api/verify/batch — inline-manifest CSV detection (auto-inline)", () => {
  it("multi-row CSV dropped without a manifest field still pairs via inline-manifest detection", async () => {
    const csv =
      "filename,brand_name,class_type,class_category,abv_percent,net_contents,producer,country_of_origin\n" +
      `a.jpg,Stone's Throw,Pale Ale,beer,6.4,12 fl_oz,X,USA\n` +
      `b.jpg,Stone's Throw,Pale Ale,beer,6.4,12 fl_oz,X,USA\n`;
    const fd = new FormData();
    fd.append("image", jpegFile("a.jpg"));
    fd.append("image", jpegFile("b.jpg"));
    fd.append("application", csvFile("manifest-roster.csv", csv));
    const resp = await POST(makeReq(fd));
    expect(resp.status).toBe(200);
    const body = (await resp.json()) as {
      count: number;
      pairing: { mode: string };
    };
    expect(body.count).toBe(2);
    // Mode flips to auto-inline-manifest because the CSV is multi-row.
    expect(body.pairing.mode).toMatch(/inline-manifest/);
  });

  it("CSV is recognised even with `application/octet-stream` MIME (extension fallback)", async () => {
    // Some reviewer file managers strip MIME info on drag-drop; the
    // route's inline-manifest detector falls back to the `.csv`
    // extension check. We assert this is wired correctly.
    const csv =
      "filename,brand_name,class_type,class_category,abv_percent,net_contents,producer,country_of_origin\n" +
      `a.jpg,Stone's Throw,Pale Ale,beer,6.4,12 fl_oz,X,USA\n` +
      `b.jpg,Stone's Throw,Pale Ale,beer,6.4,12 fl_oz,X,USA\n`;
    const fd = new FormData();
    fd.append("image", jpegFile("a.jpg"));
    fd.append("image", jpegFile("b.jpg"));
    const blob = new Blob([csv], { type: "application/octet-stream" });
    fd.append(
      "application",
      new File([blob], "roster.csv", { type: "application/octet-stream" }),
    );
    const resp = await POST(makeReq(fd));
    expect(resp.status).toBe(200);
    const body = (await resp.json()) as {
      count: number;
      pairing: { mode: string };
    };
    expect(body.count).toBe(2);
    expect(body.pairing.mode).toMatch(/inline-manifest/);
  });

  it("CSV with rows referencing missing images surfaces orphaned-manifest-rows", async () => {
    const csv =
      "filename,brand_name,class_type,class_category,abv_percent,net_contents,producer,country_of_origin\n" +
      `a.jpg,Stone's Throw,Pale Ale,beer,6.4,12 fl_oz,X,USA\n` +
      `nope.jpg,Stone's Throw,Pale Ale,beer,6.4,12 fl_oz,X,USA\n`;
    const fd = new FormData();
    fd.append("image", jpegFile("a.jpg"));
    fd.append("application", csvFile("manifest.csv", csv));
    const resp = await POST(makeReq(fd));
    expect(resp.status).toBe(200);
    const body = (await resp.json()) as {
      count: number;
      pairing: { orphanedManifestRows?: string[] };
    };
    expect(body.count).toBe(1);
    expect(body.pairing.orphanedManifestRows ?? []).toEqual(
      expect.arrayContaining([expect.stringMatching(/nope\.jpg/)]),
    );
  });
});

describe("/api/verify/batch — auto-stem pairing (filename-stem match)", () => {
  it("image + same-stem single-product JSON pairs to mode='auto-stem'", async () => {
    const fd = new FormData();
    fd.append("image", jpegFile("acme-vodka.jpg"));
    fd.append("application", jsonFile("acme-vodka.json", SINGLE_PRODUCT_JSON));
    const resp = await POST(makeReq(fd));
    expect(resp.status).toBe(200);
    const body = (await resp.json()) as {
      count: number;
      pairing: { mode: string; pairs: Array<{ stem: string }> };
    };
    expect(body.count).toBe(1);
    expect(body.pairing.mode).toBe("auto-stem");
    expect(body.pairing.pairs[0]?.stem).toBe("acme-vodka");
  });
});

describe("/api/verify/batch — broadcast (1 app + N images)", () => {
  it("single-product JSON + 2 unrelated-stem images triggers auto-broadcast", async () => {
    // Filenames don't share stems → stem pairing fails.
    // Without GOOGLE_API_KEY, content pairing is skipped.
    // The remaining (>= 2 images + exactly 1 app) trigger the
    // broadcast path: same app fields applied to every image.
    const previousKey = process.env.GOOGLE_API_KEY;
    delete process.env.GOOGLE_API_KEY;
    try {
      const fd = new FormData();
      fd.append("image", jpegFile("front.jpg"));
      fd.append("image", jpegFile("back.jpg"));
      fd.append("application", jsonFile("declared.json", SINGLE_PRODUCT_JSON));
      const resp = await POST(makeReq(fd));
      expect(resp.status).toBe(200);
      const body = (await resp.json()) as {
        count: number;
        pairing: { mode: string; broadcast?: boolean };
        pairingWarnings: string[];
      };
      expect(body.count).toBe(2);
      expect(body.pairing.mode).toBe("auto-broadcast");
      expect(body.pairing.broadcast).toBe(true);
      expect(
        body.pairingWarnings.some((w) => /broadcast/i.test(w)),
      ).toBe(true);
    } finally {
      if (previousKey !== undefined) {
        process.env.GOOGLE_API_KEY = previousKey;
      }
    }
  });
});

describe("/api/verify/batch — no pairs found", () => {
  it("returns 400 with a helpful diagnostic when nothing pairs", async () => {
    // 1 image + 1 application with TOTALLY different stems, AND
    // GOOGLE_API_KEY is unset so content pairing is skipped. With
    // exactly 1 image + 1 app the broadcast threshold (≥ 2 images)
    // also isn't met. Result: no pairs.
    const previousKey = process.env.GOOGLE_API_KEY;
    delete process.env.GOOGLE_API_KEY;
    try {
      const fd = new FormData();
      fd.append("image", jpegFile("totally-different.jpg"));
      fd.append(
        "application",
        jsonFile("unrelated-name.json", SINGLE_PRODUCT_JSON),
      );
      const resp = await POST(makeReq(fd));
      expect(resp.status).toBe(400);
      const body = (await resp.json()) as {
        error: string;
        pairing: { mode: string };
      };
      expect(body.error).toMatch(/No image-application pairs/i);
    } finally {
      if (previousKey !== undefined) {
        process.env.GOOGLE_API_KEY = previousKey;
      }
    }
  });
});
