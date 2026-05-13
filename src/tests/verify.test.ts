import { describe, it, expect, vi } from "vitest";
import sharp from "sharp";
import { verifyLabel } from "@/lib/verify";
import type {
  Extractor,
  ExtractorResult,
  ExtractedFields,
} from "@/lib/vision/types";

// Mock the OCR adapter so we never need a real Tesseract worker in tests.
// The mock returns realistic GOVERNMENT/WARNING prefix words at large
// bboxes (~40 px tall on a 100x100 mock image, which is comfortably
// above the §16.22 size threshold relative to the declared 750 ml
// container). Without these words the validator's bold/size subscores
// would have to fall back to the model's self-reported flags, and the
// orchestrator's confidence-floor gate would route otherwise-compliant
// happy-path tests to REVIEW.
vi.mock("@/lib/ocr/tesseract", () => {
  return {
    tesseractEngine: {
      id: "tesseract",
      async run() {
        return {
          text: "GOVERNMENT WARNING According to the Surgeon General",
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

  it("Unreadable image routes to REVIEW (not FAIL) with a re-photograph reason", async () => {
    // A corrupt or motion-blurred photo of a compliant label would
    // otherwise be marked FAIL (the comparators can't match because
    // the extractor read garbage). The product-correct routing is
    // REVIEW: the label might be perfectly compliant; we just don't
    // have a usable image of it. User-explicit ask 2026-05-12.
    const img = await tinyJpeg();
    const garbage: ExtractedFields = {
      brand_name: { value: "WrongBrand", confidence: 0.1 },
      class_type: { value: "WrongClass", confidence: 0.1 },
      abv_percent: { value: 0, confidence: 0.1 },
      net_contents: {
        value: { value: 0, unit: "fl_oz" },
        confidence: 0.1,
      },
      government_warning: {
        value: null,
        confidence: 0.1,
      },
      producer: { value: null, confidence: 0.1 },
      country_of_origin: { value: null, confidence: 0.1 },
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
      { extractor: buildExtractor(garbage) },
    );
    expect(result.imageQuality).toBe("bad");
    expect(result.verdict).toBe("review");
    // The first review reason should explain re-photograph rationale.
    expect(result.reviewReasons[0]).toMatch(/re-photograph|image quality/i);
  });

  it("Image quality stays GOOD when the model reads cleanly but the declared values don't match", async () => {
    // 2026-05-13 user-reported regression: a clean photo + an
    // intentionally-wrong manifest was returning "Re-photograph"
    // because the OLD imageQuality formula used the COMPARATOR's
    // confidence — and compareBrand/compareClass/etc. return low
    // confidence on mismatches even when the model READ the label
    // perfectly. Image quality must be about the IMAGE, independent
    // of whether the user typed the right declared value. The new
    // formula uses the EXTRACTOR's per-field confidence on fields
    // the model actually read (value !== null).
    const img = await tinyJpeg();
    // Extractor reads the label clearly — high confidence everywhere.
    const cleanExtraction: ExtractedFields = {
      brand_name: { value: "Mountain Lark", confidence: 0.95 },
      class_type: { value: "Stout", confidence: 0.95 },
      abv_percent: { value: 7.2, confidence: 0.95 },
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
      producer: { value: { name: "Mountain Lark Brewery", street: null, city: "Boise", state: "ID", postal_code: null, country: "USA" }, confidence: 0.85 },
      country_of_origin: { value: "USA", confidence: 0.95 },
    };
    // ...but the declared manifest is for a DIFFERENT product entirely.
    const result = await verifyLabel(
      img,
      {
        brand_name: "Mill Creek",
        class_type: "Pilsner",
        class_category: "beer",
        abv_percent: 5.2,
        net_contents: { value: 12, unit: "fl_oz" },
        producer: "Mill Creek Brewing Co., Asheville, NC",
        country_of_origin: "USA",
      },
      { extractor: buildExtractor(cleanExtraction) },
    );
    // The image was read cleanly → imageQuality must stay "good"
    // regardless of how badly the declared values mismatch.
    expect(result.imageQuality).toBe("good");
    // Verdict will be FAIL or REVIEW — that's a separate dimension
    // (the manifest disagrees with the label) — but image-quality
    // is independent.
    expect(["fail", "review"]).toContain(result.verdict);
  });
});
