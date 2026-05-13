import { describe, expect, it, vi } from "vitest";
import sharp from "sharp";
import { verifyLabel } from "@/lib/verify";
import type {
  ExtractedFields,
  Extractor,
  ExtractorResult,
} from "@/lib/vision/types";
import type { DeclaredFields } from "@/lib/types";

// OCR mock — same shape as verify-review-deferral.test.ts.
vi.mock("@/lib/ocr/tesseract", () => ({
  tesseractEngine: {
    id: "tesseract",
    async run() {
      return {
        text: "MOCK",
        words: [
            { text: "GOVERNMENT", confidence: 90, bbox: { x: 10, y: 30, width: 60, height: 16 } },
            { text: "WARNING:", confidence: 90, bbox: { x: 72, y: 30, width: 48, height: 16 } },
            { text: "(1)", confidence: 88, bbox: { x: 10, y: 50, width: 12, height: 8 } },
            { text: "According", confidence: 88, bbox: { x: 24, y: 50, width: 40, height: 8 } },
          ],
        confidence: 0.7,
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

function buildExtractor(fields: ExtractedFields): Extractor {
  return {
    id: "mock:crosslink",
    networkRequired: false,
    async extract(): Promise<ExtractorResult> {
      return {
        fields,
        rawOutput: fields,
        latencyMs: 100,
        modelId: "mock:crosslink",
        modelVersion: "mock-v1",
        promptHash: "deadbeefdeadbeef",
        cost: { inputTokens: 0, outputTokens: 0, costUsd: 0 },
      };
    },
  };
}

// Reproducer for the UI-audit regression caught 2026-05-12 (third
// pass): a US-domestic label whose vision extraction returned
// `country_of_origin: null` AND a producer whose state corroborates
// USA. The standalone `compareCountry` correctly routes to REVIEW
// ("label doesn't visibly print a country"), but the producer
// comparator's country sub-component PASSes via implicit-USA
// inference. The orchestrator now cross-links the two so a label
// proven domestic via the producer address doesn't surprise-route
// the verdict to REVIEW.

const DECLARED: DeclaredFields = {
  brand_name: "Mill Creek",
  class_type: "Pilsner",
  class_category: "beer",
  abv_percent: 5.2,
  net_contents: { value: 12, unit: "fl_oz" },
  producer: {
    name: "Mill Creek Beverage Co.",
    street: null,
    city: "Asheville",
    state: "NC",
    postal_code: null,
    country: "USA",
  },
  country_of_origin: "USA",
};

const COMPLIANT_GOV_WARNING_TEXT =
  "GOVERNMENT WARNING: (1) According to the Surgeon General, women " +
  "should not drink alcoholic beverages during pregnancy because of " +
  "the risk of birth defects. (2) Consumption of alcoholic beverages " +
  "impairs your ability to drive a car or operate machinery, and may " +
  "cause health problems.";

const FIELDS_DOMESTIC_NO_COUNTRY: ExtractedFields = {
  brand_name: { value: "Mill Creek", confidence: 0.95 },
  class_type: { value: "Pilsner", confidence: 0.92 },
  abv_percent: { value: 5.2, confidence: 0.95 },
  net_contents: { value: { value: 12, unit: "fl_oz" }, confidence: 0.9 },
  government_warning: {
    value: {
      raw_text: COMPLIANT_GOV_WARNING_TEXT,
      prefix_text: "GOVERNMENT WARNING",
      prefix_bbox: { x: 100, y: 200, width: 400, height: 20 },
      prefix_appears_bold: true,
      prefix_appears_caps: true,
    },
    confidence: 0.9,
  },
  producer: {
    value: {
      name: "Mill Creek Beverage Co.",
      street: null,
      city: "Asheville",
      state: "NC",
      postal_code: null,
      country: null,
    },
    confidence: 0.9,
  },
  // Crucial: extracted country is null (US-domestic label doesn't
  // print "USA" — the common real-world case).
  country_of_origin: { value: null, confidence: 0 },
};

describe("verifyLabel — country / producer cross-link", () => {
  it("PASSes when extracted country is null AND producer's address corroborates USA", async () => {
    const img = await tinyJpeg();
    const result = await verifyLabel(img, DECLARED, {
      extractor: buildExtractor(FIELDS_DOMESTIC_NO_COUNTRY),
    });
    // The standalone country comparator would normally return REVIEW
    // here, but the cross-link promotes it to PASS because the
    // producer's country component already PASSed via inference.
    expect(result.fields.country_of_origin.status).toBe("pass");
    expect(result.fields.producer.status).toBe("pass");
    expect(result.verdict).toBe("pass");
    // The "promoted" reason text references the producer address.
    expect(result.fields.country_of_origin.reason).toMatch(
      /producer address|corroborates|domestic/i,
    );
  });

  it("does NOT promote country REVIEW to PASS when declared producer is freeform string", async () => {
    // The cross-link requires a structured producer.country to know
    // what to assert; freeform producers don't qualify and the
    // standalone country REVIEW stands.
    const freeformDeclared: DeclaredFields = {
      ...DECLARED,
      producer: "Mill Creek Beverage Co., Asheville, NC, USA",
    };
    const img = await tinyJpeg();
    const result = await verifyLabel(img, freeformDeclared, {
      extractor: buildExtractor(FIELDS_DOMESTIC_NO_COUNTRY),
    });
    // Producer freeform may or may not PASS depending on fuzz-match;
    // but country REVIEW must persist regardless.
    expect(result.fields.country_of_origin.status).toBe("review");
  });

  it("does NOT promote when producer's country component itself is REVIEW or FAIL", async () => {
    // Producer's city doesn't match — corroborating fails — country
    // component falls back. The cross-link only fires when the
    // producer's country component is explicitly PASS.
    const fields: ExtractedFields = {
      ...FIELDS_DOMESTIC_NO_COUNTRY,
      producer: {
        value: {
          name: "Different Co.",
          street: null,
          city: "Different City",
          state: "ZZ", // not a real state code
          postal_code: null,
          country: null,
        },
        confidence: 0.9,
      },
    };
    const img = await tinyJpeg();
    const result = await verifyLabel(img, DECLARED, {
      extractor: buildExtractor(fields),
    });
    // Country REVIEW stays REVIEW (no PASS promotion).
    expect(result.fields.country_of_origin.status).toBe("review");
  });
});
