import { describe, it, expect, vi } from "vitest";
import sharp from "sharp";
import { verifyLabel } from "@/lib/verify";
import type {
  Extractor,
  ExtractorResult,
  ExtractedFields,
} from "@/lib/vision/types";

// Mock the OCR adapter so we never need a real Tesseract worker in tests.
vi.mock("@/lib/ocr/tesseract", () => {
  return {
    tesseractEngine: {
      id: "tesseract",
      async run() {
        return {
          text: "Mock OCR Output",
          words: [],
          confidence: 0.7,
          latencyMs: 5,
          engine: "tesseract",
        };
      },
    },
    warmupTesseract: async () => undefined,
  };
});

// Tiny solid-color JPEG buffer for the verify pipeline to swallow.
async function tinyJpeg(): Promise<Buffer> {
  return await sharp({
    create: { width: 100, height: 100, channels: 3, background: "#fff" },
  })
    .jpeg()
    .toBuffer();
}

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

const COMPLIANT_FIELDS: ExtractedFields = {
  brand_name: { value: "Stone's Throw Brewing", confidence: 0.95 },
  class_type: { value: "India Pale Ale", confidence: 0.9 },
  abv_percent: { value: 6.4, confidence: 0.95 },
  net_contents: {
    value: { value: 12, unit: "fl_oz" },
    confidence: 0.9,
  },
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

describe("verifyLabel (happy path)", () => {
  it("PASS on a fully compliant extraction", async () => {
    const img = await tinyJpeg();
    const result = await verifyLabel(
      img,
      {
        brand_name: "Stone's Throw Brewing",
        class_type: "India Pale Ale",
        class_category: "beer",
        abv_percent: 6.4,
        net_contents: { value: 12, unit: "fl_oz" },
        producer: {
          name: "Stone's Throw Brewing Co.",
          street: "14 Mill St",
          city: "Asheville",
          state: "NC",
          postal_code: "28801",
          country: "USA",
        },
        country_of_origin: "USA",
      },
      { extractor: buildExtractor(COMPLIANT_FIELDS) },
    );
    expect(result.verdict).toBe("pass");
    expect(result.governmentWarning.status).toBe("pass");
    expect(result.fields.brand_name.status).toBe("pass");
    expect(result.fields.abv_percent.status).toBe("pass");
    expect(result.timings.total).toBeGreaterThanOrEqual(0);
  });

  it("FAIL when declared ABV diverges beyond class tolerance", async () => {
    const img = await tinyJpeg();
    const result = await verifyLabel(
      img,
      {
        brand_name: "Stone's Throw Brewing",
        class_type: "India Pale Ale",
        class_category: "beer",
        abv_percent: 4.0, // declared 4.0, label says 6.4 — off by 2.4pp on beer's 0.3pp band
        net_contents: { value: 12, unit: "fl_oz" },
        producer: "Stone's Throw Brewing Co.",
        country_of_origin: "USA",
      },
      { extractor: buildExtractor(COMPLIANT_FIELDS) },
    );
    expect(result.verdict).toBe("fail");
    expect(result.fields.abv_percent.status).toBe("fail");
  });

  it("Image quality is independent of verdict", async () => {
    const img = await tinyJpeg();
    // Force low extractor confidence everywhere.
    const lowConf: ExtractedFields = {
      ...COMPLIANT_FIELDS,
      brand_name: { ...COMPLIANT_FIELDS.brand_name, confidence: 0.2 },
      abv_percent: { ...COMPLIANT_FIELDS.abv_percent, confidence: 0.2 },
    };
    const result = await verifyLabel(
      img,
      {
        brand_name: "Stone's Throw Brewing",
        class_type: "India Pale Ale",
        class_category: "beer",
        abv_percent: 6.4,
        net_contents: { value: 12, unit: "fl_oz" },
        producer: "Stone's Throw Brewing Co.",
        country_of_origin: "USA",
      },
      { extractor: buildExtractor(lowConf) },
    );
    // Even with low confidence the underlying values match, so the
    // compliance verdict is still computable; the image quality column
    // surfaces the confidence concern separately.
    expect(result.imageQuality).not.toBe("good");
  });
});
