import { describe, it, expect, vi } from "vitest";
import sharp from "sharp";
import { verifyLabel, REVIEW_CONFIDENCE_THRESHOLD } from "@/lib/verify";
import type {
  Extractor,
  ExtractorResult,
  ExtractedFields,
} from "@/lib/vision/types";
import type { DeclaredFields } from "@/lib/types";

// Same OCR mock as verify.test.ts — no real Tesseract worker.
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

const DECLARED: DeclaredFields = {
  brand_name: "Stone's Throw Brewing",
  class_type: "India Pale Ale",
  class_category: "beer",
  abv_percent: 6.4,
  net_contents: { value: 12, unit: "fl_oz" },
  producer: "Stone's Throw Brewing Co.",
  country_of_origin: "USA",
};

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
    confidence: 0.9,
  },
  country_of_origin: { value: "USA", confidence: 0.95 },
};

describe("verifyLabel: intelligence-first deferral", () => {
  it("PASS when all fields are confidently above threshold", async () => {
    const img = await tinyJpeg();
    const result = await verifyLabel(img, DECLARED, {
      extractor: buildExtractor(COMPLIANT_FIELDS),
    });
    expect(result.verdict).toBe("pass");
    expect(result.requiresHumanReview).toBe(false);
    expect(result.reviewReasons).toEqual([]);
  });

  it("REVIEW when one field's confidence sits right at the threshold floor", async () => {
    // Country comparator passes country_of_origin's extracted confidence
    // straight through to FieldComparison.confidence. Dropping it to 0.70
    // (one tick under 0.75) is enough to trip the second-layer floor in
    // verify.ts and downgrade what would otherwise be a PASS to REVIEW.
    const img = await tinyJpeg();
    const lowCountry: ExtractedFields = {
      ...COMPLIANT_FIELDS,
      country_of_origin: { value: "USA", confidence: 0.7 },
    };
    const result = await verifyLabel(img, DECLARED, {
      extractor: buildExtractor(lowCountry),
    });
    expect(result.verdict).toBe("review");
    expect(result.requiresHumanReview).toBe(true);
    expect(result.reviewReasons.length).toBeGreaterThan(0);
    expect(result.reviewReasons.some((r) => r.includes("Country"))).toBe(true);
    expect(result.reviewReasons[0]).toMatch(/below 0\.75|REVIEW/);
  });

  it("FAIL is never downgraded to REVIEW even with low confidence", async () => {
    const img = await tinyJpeg();
    // ABV declared 4.0 but printed 6.4 — well outside the beer 0.3 pp band.
    // Confidence is intentionally low (0.4) to prove the FAIL still sticks
    // and is not silently turned into a REVIEW.
    const lowConfFail: ExtractedFields = {
      ...COMPLIANT_FIELDS,
      abv_percent: { value: 6.4, confidence: 0.4 },
    };
    const result = await verifyLabel(
      img,
      { ...DECLARED, abv_percent: 4.0 },
      { extractor: buildExtractor(lowConfFail) },
    );
    expect(result.verdict).toBe("fail");
    // requiresHumanReview is strictly tied to verdict === "review".
    expect(result.requiresHumanReview).toBe(false);
    expect(result.fields.abv_percent.status).toBe("fail");
  });

  it("reviewReasons are human-readable and reference the field", async () => {
    const img = await tinyJpeg();
    const lowCountry: ExtractedFields = {
      ...COMPLIANT_FIELDS,
      country_of_origin: { value: "USA", confidence: 0.5 },
    };
    const result = await verifyLabel(img, DECLARED, {
      extractor: buildExtractor(lowCountry),
    });
    expect(result.verdict).toBe("review");
    const joined = result.reviewReasons.join("\n");
    expect(joined).toMatch(/Country/);
    expect(joined).toMatch(/0\.50/);
    expect(joined).toMatch(/below 0\.75/);
  });

  it("exposes REVIEW_CONFIDENCE_THRESHOLD at 0.75", () => {
    expect(REVIEW_CONFIDENCE_THRESHOLD).toBe(0.75);
  });

  it("REVIEW when ABV confidence is 0.65 (per-field comparator floor 0.70)", async () => {
    // Sanity check the per-field tuning: ABV's internal floor was bumped
    // from 0.60 → 0.70 to align with the new policy.
    const img = await tinyJpeg();
    const lowAbv: ExtractedFields = {
      ...COMPLIANT_FIELDS,
      abv_percent: { value: 6.4, confidence: 0.65 },
    };
    const result = await verifyLabel(img, DECLARED, {
      extractor: buildExtractor(lowAbv),
    });
    expect(result.fields.abv_percent.status).toBe("review");
    expect(result.verdict).toBe("review");
    expect(result.requiresHumanReview).toBe(true);
  });
});
