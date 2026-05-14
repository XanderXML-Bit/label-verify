import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import sharp from "sharp";
import { verifyLabel } from "@/lib/verify";
import type {
  Extractor,
  ExtractorResult,
  ExtractedFields,
} from "@/lib/vision/types";

// Mock OCR so we don't need a real Tesseract worker in tests.
vi.mock("@/lib/ocr/tesseract", () => ({
  tesseractEngine: {
    id: "tesseract",
    async run() {
      return {
        text: "Mock OCR Output",
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

// Mock the second-opinion selector module. Wave-22 routes the borderline
// recheck through buildSecondOpinionExtractor(), which (by default) picks
// Gemini 2.5 Flash — but tests don't care WHICH provider runs, only that
// the orchestration logic threads the result correctly. Mocking the
// selector keeps the test independent of provider choice and avoids
// reaching for any real SDK.
const mockSecondOpinionExtract = vi.fn<
  (...args: Parameters<Extractor["extract"]>) => ReturnType<Extractor["extract"]>
>();
vi.mock("@/lib/vision/second-opinion", () => {
  return {
    buildSecondOpinionExtractor: async () => ({
      id: "mock:second-opinion",
      networkRequired: true,
      extract: mockSecondOpinionExtract,
    }),
    secondOpinionAvailable: (env: { GOOGLE_API_KEY?: string; OPENAI_API_KEY?: string }) =>
      !!env.GOOGLE_API_KEY || !!env.OPENAI_API_KEY,
  };
});

async function tinyJpeg(): Promise<Buffer> {
  return await sharp({
    create: { width: 100, height: 100, channels: 3, background: "#fff" },
  })
    .jpeg()
    .toBuffer();
}

function compliantFields(): ExtractedFields {
  return {
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
}

function buildExtractor(fields: ExtractedFields): Extractor {
  return {
    id: "mock:primary",
    networkRequired: false,
    async extract(): Promise<ExtractorResult> {
      return {
        fields,
        rawOutput: fields,
        latencyMs: 100,
        modelId: "mock:primary",
        modelVersion: "primary-v1",
        promptHash: "deadbeefdeadbeef",
        cost: { inputTokens: 0, outputTokens: 0, costUsd: 0 },
      };
    },
  };
}

const declared = {
  brand_name: "Stone's Throw Brewing",
  class_type: "India Pale Ale",
  class_category: "beer" as const,
  abv_percent: 6.4,
  net_contents: { value: 12, unit: "fl_oz" as const },
  producer: {
    name: "Stone's Throw Brewing Co.",
    street: "14 Mill St",
    city: "Asheville",
    state: "NC",
    postal_code: "28801",
    country: "USA",
  },
  country_of_origin: "USA",
};

describe("verifyLabel — second-opinion vision call on borderline GW", () => {
  beforeEach(() => {
    mockSecondOpinionExtract.mockReset();
    process.env.OPENAI_API_KEY = "test-key-not-real";
    process.env.MODEL_FALLBACK = "gpt-5.4-nano";
  });
  afterEach(() => {
    delete process.env.OPENAI_API_KEY;
    delete process.env.MODEL_FALLBACK;
  });

  it("fires on a model-self-report-only bold-PASS and restores PASS on agreement", async () => {
    // Wave-7 change: on a fully-compliant primary extraction with the
    // bold subscore taking the model-self-report-only fallback (no OCR
    // pixel measurement disagreed), the orchestrator fires the second-
    // opinion call to corroborate. If the second model also reports
    // bold = pass, the verdict stays PASS and no review reason is
    // surfaced — independent cross-provider agreement substitutes for
    // pixel measurement. The mock OCR + tiny white JPEG in this suite
    // exercise exactly that fallback branch.
    const compliant = compliantFields();
    mockSecondOpinionExtract.mockResolvedValueOnce({
      fields: compliant,
      rawOutput: compliant,
      latencyMs: 1100,
      modelId: "openai:gpt-5.4-nano",
      modelVersion: "gpt-5.4-nano",
      promptHash: "secondopinionbold01",
      cost: { inputTokens: 0, outputTokens: 0, costUsd: 0 },
    });

    const img = await tinyJpeg();
    const result = await verifyLabel(img, declared, {
      extractor: buildExtractor(compliantFields()),
    });

    expect(result.governmentWarning.status).toBe("pass");
    expect(result.verdict).toBe("pass");
    // Second opinion fired (mock returns the same compliant warning,
    // so it agrees with the primary).
    expect(mockSecondOpinionExtract).toHaveBeenCalledTimes(1);
    expect(result.secondOpinion?.agreesWithPrimary).toBe(true);
  });

  it("restores PASS only when second-opinion bold also passes (disagreement → REVIEW)", async () => {
    // Same fully-compliant primary as above, but the second opinion
    // disagrees about bold. Per the wave-7 design, the verdict
    // downgrades from PASS → REVIEW with a disagreement reason.
    const compliant = compliantFields();
    const secondOpinionBoldFail = compliantFields();
    secondOpinionBoldFail.government_warning.value!.prefix_appears_bold = false;
    mockSecondOpinionExtract.mockResolvedValueOnce({
      fields: secondOpinionBoldFail,
      rawOutput: secondOpinionBoldFail,
      latencyMs: 1100,
      modelId: "openai:gpt-5.4-nano",
      modelVersion: "gpt-5.4-nano",
      promptHash: "secondopiniondisagree",
      cost: { inputTokens: 0, outputTokens: 0, costUsd: 0 },
    });

    const img = await tinyJpeg();
    const result = await verifyLabel(img, declared, {
      extractor: buildExtractor(compliant),
    });

    expect(result.governmentWarning.status).toBe("pass");
    expect(mockSecondOpinionExtract).toHaveBeenCalledTimes(1);
    // Verdict downgrades because second opinion disagrees on bold.
    expect(result.verdict).toBe("review");
    expect(result.reviewReasons.some((r) => /bold subscore/i.test(r))).toBe(true);
    expect(result.secondOpinion?.agreesWithPrimary).toBe(false);
  });

  it("fires on a REVIEW Gov-Warning and surfaces an agreeing second opinion", async () => {
    // Force the primary GW into REVIEW: canonical text + caps PASS,
    // but `prefix_appears_bold: null` AND no OCR words (default mock)
    // → bold subscore returns REVIEW at 0.5 → aggregate gov.status
    // = REVIEW. This matches the most common borderline case in
    // production: model couldn't tell if the prefix was bold.
    const reviewFields = compliantFields();
    reviewFields.government_warning.value!.prefix_appears_bold = null;
    reviewFields.government_warning.confidence = 0.5;

    // Second opinion returns the same shape → both models REVIEW → agree.
    mockSecondOpinionExtract.mockResolvedValueOnce({
      fields: reviewFields,
      rawOutput: reviewFields,
      latencyMs: 1200,
      modelId: "openai:gpt-5.4-nano",
      modelVersion: "gpt-5.4-nano",
      promptHash: "secondopinion0001",
      cost: { inputTokens: 0, outputTokens: 0, costUsd: 0 },
    });

    const img = await tinyJpeg();
    const result = await verifyLabel(img, declared, {
      extractor: buildExtractor(reviewFields),
    });

    expect(result.governmentWarning.status).toBe("review");
    expect(mockSecondOpinionExtract).toHaveBeenCalledTimes(1);
    expect(result.secondOpinion).toBeDefined();
    expect(result.secondOpinion!.modelId).toBe("openai:gpt-5.4-nano");
    expect(typeof result.secondOpinion!.latencyMs).toBe("number");
    expect(result.secondOpinion!.agreesWithPrimary).toBe(true);
  });

  it("flags disagreement when second opinion lands on a different verdict", async () => {
    // Primary GW = REVIEW (compliant text but ambiguous bold). Second
    // opinion returns a fully-compliant read → PASS. The result should
    // surface `agreesWithPrimary: false`.
    const primaryFields = compliantFields();
    // Same REVIEW-inducing shape as the "agrees" test (null bold).
    primaryFields.government_warning.value!.prefix_appears_bold = null;
    primaryFields.government_warning.confidence = 0.5;

    // Second opinion re-reads the label and sees a fully compliant
    // warning — disagrees with the primary's borderline read.
    const secondReadCompliant = compliantFields();
    mockSecondOpinionExtract.mockResolvedValueOnce({
      fields: secondReadCompliant,
      rawOutput: secondReadCompliant,
      latencyMs: 1100,
      modelId: "openai:gpt-5.4-nano",
      modelVersion: "gpt-5.4-nano",
      promptHash: "secondopinion0002",
      cost: { inputTokens: 0, outputTokens: 0, costUsd: 0 },
    });

    const img = await tinyJpeg();
    const result = await verifyLabel(img, declared, {
      extractor: buildExtractor(primaryFields),
    });

    expect(mockSecondOpinionExtract).toHaveBeenCalledTimes(1);
    expect(result.secondOpinion).toBeDefined();
    expect(result.secondOpinion!.agreesWithPrimary).toBe(false);
    expect(result.secondOpinion!.governmentWarning.status).toBe("pass");
  });

  it("does NOT fire when OPENAI_API_KEY is unset (no fallback available)", async () => {
    delete process.env.OPENAI_API_KEY;
    // Use the same REVIEW-inducing shape that would otherwise fire
    // the second opinion — proves the absent key (not the verdict) is
    // what suppressed it.
    const paraphrased = compliantFields();
    paraphrased.government_warning.value!.prefix_appears_bold = null;
    paraphrased.government_warning.confidence = 0.5;
    const img = await tinyJpeg();
    const result = await verifyLabel(img, declared, {
      extractor: buildExtractor(paraphrased),
    });
    expect(mockSecondOpinionExtract).not.toHaveBeenCalled();
    expect(result.secondOpinion).toBeUndefined();
  });

  it("survives a second-opinion failure without degrading the primary verdict", async () => {
    // Best-effort: a failed second-opinion call must NOT break the
    // primary response. The reviewer still gets the primary verdict.
    const paraphrased = compliantFields();
    paraphrased.government_warning.value!.prefix_appears_bold = null;
    paraphrased.government_warning.confidence = 0.5;
    mockSecondOpinionExtract.mockRejectedValueOnce(new Error("502 from upstream"));

    const img = await tinyJpeg();
    const result = await verifyLabel(img, declared, {
      extractor: buildExtractor(paraphrased),
    });

    expect(mockSecondOpinionExtract).toHaveBeenCalledTimes(1);
    // Second opinion did not attach (best-effort fail) — primary
    // verdict still ships.
    expect(result.secondOpinion).toBeUndefined();
    expect(result.verdict).toBeDefined();
  });
});
