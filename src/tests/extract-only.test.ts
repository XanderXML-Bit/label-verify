// Wave-32 audit pin (Sub-agent B G3): `extractOnly` duplicates ~190
// lines of `verifyLabel` orchestration (preprocess + OCR-race + GW
// validator + image-quality formula + fallback + net-contents default).
// `api-extract.test.ts` mocks `extractOnly` itself, so the function
// never runs in tests. This pin exercises the no-declared-fields
// extract path end-to-end via the same extractor-injection pattern as
// verify.test.ts.

import { describe, expect, it, vi } from "vitest";
import sharp from "sharp";
import { extractOnly } from "@/lib/verify";
import type {
  Extractor,
  ExtractorResult,
  ExtractedFields,
} from "@/lib/vision/types";

vi.mock("@/lib/ocr/tesseract", () => ({
  tesseractEngine: {
    id: "tesseract",
    async run() {
      return {
        text: "GOVERNMENT WARNING",
        words: [
          { text: "GOVERNMENT", confidence: 90, bbox: { x: 10, y: 30, width: 60, height: 16 } },
          { text: "WARNING:", confidence: 90, bbox: { x: 72, y: 30, width: 48, height: 16 } },
          { text: "(1)", confidence: 88, bbox: { x: 10, y: 50, width: 12, height: 8 } },
          { text: "According", confidence: 88, bbox: { x: 24, y: 50, width: 40, height: 8 } },
        ],
        confidence: 0.85,
        latencyMs: 5,
        engine: "tesseract",
      };
    },
  },
  warmupTesseract: async () => undefined,
}));

async function tinyJpeg(): Promise<Buffer> {
  return await sharp({
    create: { width: 100, height: 100, channels: 3, background: "#fff" },
  })
    .jpeg()
    .toBuffer();
}

const COMPLIANT_FIELDS: ExtractedFields = {
  brand_name: { value: "Stone's Throw Brewing", confidence: 0.95 },
  class_type: { value: "India Pale Ale", confidence: 0.9 },
  abv_percent: { value: 6.4, confidence: 0.95 },
  net_contents: { value: { value: 12, unit: "fl_oz" }, confidence: 0.9 },
  government_warning: {
    value: {
      raw_text:
        "GOVERNMENT WARNING: (1) According to the Surgeon General, women should not drink alcoholic beverages during pregnancy because of the risk of birth defects. (2) Consumption of alcoholic beverages impairs your ability to drive a car or operate machinery, and may cause health problems.",
      prefix_text: "GOVERNMENT WARNING",
      prefix_bbox: { x: 100, y: 200, width: 400, height: 20 },
      prefix_appears_bold: true,
      prefix_appears_caps: true,
    },
    confidence: 0.9,
  },
  producer: {
    value: {
      name: "Stone's Throw Brewing Co.",
      street: "14 Mill St",
      city: "Asheville",
      state: "NC",
      postal_code: "28801",
      country: "USA",
    },
    confidence: 0.85,
  },
  country_of_origin: { value: "USA", confidence: 0.95 },
};

function buildExtractor(fields: ExtractedFields): Extractor {
  return {
    id: "mock:test",
    networkRequired: false,
    async extract(): Promise<ExtractorResult> {
      return {
        fields,
        rawOutput: fields,
        latencyMs: 100,
        modelId: "mock:test",
        modelVersion: "mock-v1",
        promptHash: "deadbeefdeadbeef",
        cost: { inputTokens: 0, outputTokens: 0, costUsd: 0 },
      };
    },
  };
}

describe("extractOnly", () => {
  it("returns extracted fields + Gov-Warning subscores without requiring declared input", async () => {
    const res = await extractOnly(await tinyJpeg(), {
      extractor: buildExtractor(COMPLIANT_FIELDS),
    });
    expect(res.extracted.brand_name?.value).toBe("Stone's Throw Brewing");
    expect(res.extracted.abv_percent?.value).toBe(6.4);
    expect(res.governmentWarning.status).toBe("pass");
    expect(res.modelId).toBe("mock:test");
    expect(res.timings.total).toBeGreaterThanOrEqual(0);
  });

  it("substitutes a default net_contents when the extractor returns null (12 fl_oz fallback)", async () => {
    const nullNc: ExtractedFields = {
      ...COMPLIANT_FIELDS,
      net_contents: { value: null, confidence: 0 },
    };
    // Should not throw — the size subscore needs a net_contents to
    // derive minMm, so the function falls back to 12 fl_oz internally.
    const res = await extractOnly(await tinyJpeg(), {
      extractor: buildExtractor(nullNc),
    });
    // The function should still produce a coherent Gov-Warning subscore set.
    expect(["pass", "review", "fail"]).toContain(res.governmentWarning.status);
    expect(res.governmentWarning.subscores).toHaveProperty("size");
  });

  it("populates imageQuality from extractor confidences", async () => {
    const res = await extractOnly(await tinyJpeg(), {
      extractor: buildExtractor(COMPLIANT_FIELDS),
    });
    expect(["good", "low", "bad"]).toContain(res.imageQuality);
  });

  it("always emits a `note` string (banner copy for the no-application UI)", async () => {
    const res = await extractOnly(await tinyJpeg(), {
      extractor: buildExtractor(COMPLIANT_FIELDS),
    });
    expect(typeof res.note).toBe("string");
    expect(res.note.length).toBeGreaterThan(0);
  });
});
