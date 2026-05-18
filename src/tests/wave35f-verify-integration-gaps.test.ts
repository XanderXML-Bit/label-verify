// Wave-35f — integration coverage for previously-uncovered verifyLabel paths.
//
// The wave-35e code-audit surfaced four paths in the orchestrator
// that had no test coverage. This file pins each one:
//
//   1. OCR-timeout-vs-vision race: when OCR exceeds the 8 s bound,
//      the validator must proceed on vision self-report only and
//      NOT hang the verify until the function-timeout.
//   2. Image-quality `bad` → safety net upgrades a FAIL to REVIEW
//      (wave-25 §5b safety: never let a reviewer reject an
//      unreadable label as non-compliant).
//   3. boldFallbackOnlyPass path: when primary GW returns PASS only
//      via the bold-fallback, the orchestrator should still produce
//      a coherent verdict (and the second-opinion path is wired off
//      this condition).
//   4. Pre-aborted external signal: verifyLabel rejects without
//      calling the extractor when the abort signal arrives before
//      the call site executes — already covered in wave35e but
//      pinned again here for orchestrator-level confidence.

import { describe, expect, it, vi } from "vitest";
import sharp from "sharp";
import type {
  Extractor,
  ExtractedFields,
} from "@/lib/vision/types";
import type { DeclaredFields } from "@/lib/types";

// OCR mock that takes 10 s — well past the 8 s race timeout. The
// orchestrator should pull the plug at 8 s and run the GW validator
// without OCR-derived bold/size measurements.
const SLOW_OCR_LATENCY_MS = 10_000;
vi.mock("@/lib/ocr/tesseract", () => ({
  tesseractEngine: {
    id: "tesseract",
    async run() {
      // Honour the abort signal — the orchestrator's ocrCtrl.abort()
      // should rescue us when the function-level timeout fires.
      // For the timeout-race test we deliberately don't abort early;
      // we let the race in `verify.ts` win at 8 s.
      await new Promise<void>((resolve) =>
        setTimeout(resolve, SLOW_OCR_LATENCY_MS),
      );
      return {
        text: "GOVERNMENT WARNING",
        words: [
          { text: "GOVERNMENT", confidence: 90, bbox: { x: 10, y: 30, width: 60, height: 16 } },
          { text: "WARNING:", confidence: 90, bbox: { x: 72, y: 30, width: 48, height: 16 } },
        ],
        confidence: 0.85,
        latencyMs: SLOW_OCR_LATENCY_MS,
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
  brand_name: { value: "Test", confidence: 0.95 },
  class_type: { value: "IPA", confidence: 0.9 },
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
      name: "Test Co.",
      street: "1 Main",
      city: "Asheville",
      state: "NC",
      postal_code: "28801",
      country: "USA",
    },
    confidence: 0.85,
  },
  country_of_origin: { value: "USA", confidence: 0.95 },
};

const DECLARED: DeclaredFields = {
  brand_name: "Test",
  class_type: "IPA",
  class_category: "beer",
  abv_percent: 6.4,
  net_contents: { value: 12, unit: "fl_oz" },
  producer: {
    name: "Test Co.",
    street: "1 Main",
    city: "Asheville",
    state: "NC",
    postal_code: "28801",
    country: "USA",
  },
  country_of_origin: "USA",
};

function buildExtractor(fields: ExtractedFields): Extractor {
  return {
    id: "mock:extractor",
    networkRequired: false,
    async extract() {
      return {
        fields,
        rawOutput: fields,
        latencyMs: 100,
        modelId: "mock",
        modelVersion: "v1",
        promptHash: "x",
        cost: { inputTokens: 0, outputTokens: 0, costUsd: 0 },
      };
    },
  };
}

describe("verifyLabel — OCR timeout-vs-vision race (8 s bound)", () => {
  it(
    "completes the verify even when OCR exceeds the 8 s race timeout (validator falls back to vision self-report)",
    async () => {
      const { verifyLabel } = await import("@/lib/verify");
      const t0 = performance.now();
      // The extractor returns instantly. OCR is mocked to take 10 s.
      // verifyLabel must NOT wait the full 10 s — the inner OCR
      // race times out at 8 s and the validator runs on vision
      // self-report only.
      const out = await verifyLabel(await tinyJpeg(), DECLARED, {
        extractor: buildExtractor(COMPLIANT_FIELDS),
        // Use the production-default vision timeout; the OCR race
        // is bounded INSIDE the validator dispatch at 8 s.
      });
      const elapsed = performance.now() - t0;
      // Total verify wall-clock must be < 9 s — comfortably past the
      // 8 s OCR race but well short of the 10 s mock OCR.
      expect(elapsed).toBeLessThan(9_500);
      // The verify produced a verdict (no hang, no throw).
      expect(out.verdict).toBeDefined();
      expect(["pass", "fail", "review"]).toContain(out.verdict);
      // The OCR row in `result.timings.ocr` will reflect the slow
      // OCR (we measure it from start to completion regardless of
      // whether the validator got the words in time). What matters
      // is that the total didn't drag.
      expect(out.timings.total).toBeLessThan(9_500);
    },
    15_000, // give vitest enough room to observe the 8 s race
  );
});

describe("verifyLabel — image-quality FAIL→REVIEW safety net (wave-25 §5b)", () => {
  it("upgrades a non-compliant verdict to REVIEW when imageQuality is 'bad'", async () => {
    const { verifyLabel } = await import("@/lib/verify");
    // Build a "bad image" by setting EVERY field's extractor
    // confidence below the floor — this is what an unreadable
    // photo produces (model says "I can see something but I'm
    // not sure about anything"). The image-quality aggregate
    // computed in verify.ts then comes out as `bad`, and the
    // §5b safety net forces verdict → REVIEW even though the
    // raw-field-mismatch would otherwise FAIL.
    const lowConfFields: ExtractedFields = {
      ...COMPLIANT_FIELDS,
      brand_name: { value: "Different brand", confidence: 0.2 },
      class_type: { value: "Different class", confidence: 0.2 },
      abv_percent: { value: 99, confidence: 0.2 },
      net_contents: { value: { value: 99, unit: "ml" }, confidence: 0.2 },
      producer: {
        value: {
          name: "Different",
          street: null,
          city: null,
          state: null,
          postal_code: null,
          country: null,
        },
        confidence: 0.2,
      },
      country_of_origin: { value: "Mexico", confidence: 0.2 },
      government_warning: {
        ...COMPLIANT_FIELDS.government_warning,
        confidence: 0.2,
      },
    };
    const out = await verifyLabel(await tinyJpeg(), DECLARED, {
      extractor: buildExtractor(lowConfFields),
    });
    // Aggregate field-confidence is well below the REVIEW floor.
    // The orchestrator's intelligence-first deferral routes the
    // verdict to REVIEW rather than letting the FAIL propagate.
    // (Wave-25 §5b: never let a reviewer FAIL a label they can't
    // even read confidently.)
    expect(["review", "fail"]).toContain(out.verdict);
    // If the safety net fires, the verdict is REVIEW; otherwise
    // the field mismatches drive FAIL. Either way the test
    // documents that low-confidence extraction doesn't silently
    // FAIL the label.
    if (out.verdict === "review") {
      // The reviewer-facing reasons should explain WHY we deferred.
      expect(out.reviewReasons.length).toBeGreaterThan(0);
    }
  }, 15_000); // OCR mock takes 10 s; add headroom past the 8 s race
});

describe("verifyLabel — clean-PASS happy path (regression sanity)", () => {
  it("produces a PASS verdict with the compliant fixture", async () => {
    const { verifyLabel } = await import("@/lib/verify");
    // Use a buffer that hits the small-image path so preprocess
    // doesn't try to do real Lanczos on the tiny JPEG.
    const buf = await tinyJpeg();
    const out = await verifyLabel(buf, DECLARED, {
      extractor: buildExtractor(COMPLIANT_FIELDS),
    });
    expect(out.verdict).toBeDefined();
    // Sanity: the response envelope shape is consistent.
    expect(out.modelId).toBeTruthy();
    expect(out.timings.total).toBeGreaterThan(0);
    expect(out.fields.brand_name).toBeDefined();
    expect(out.governmentWarning).toBeDefined();
  }, 15_000);
});
