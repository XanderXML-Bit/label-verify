// Wave-32 audit pin (Sub-agent B B6): the `opts.recordTrace` callback is
// the only mechanism `/api/debug/last`'s ring buffer hears about a
// completed verify. The call site lives inside a try/catch swallow
// (so a throwing sink can never break a real verify), but neither the
// trace-shape nor the swallow has been exercised end-to-end.

import { describe, expect, it, vi } from "vitest";
import sharp from "sharp";
import { verifyLabel } from "@/lib/verify";
import type {
  Extractor,
  ExtractorResult,
  ExtractedFields,
} from "@/lib/vision/types";
import type { VerifyTrace } from "@/lib/types";

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

function compliantExtractor(): Extractor {
  return {
    id: "mock:trace",
    networkRequired: false,
    async extract(): Promise<ExtractorResult> {
      return {
        fields: COMPLIANT_FIELDS,
        rawOutput: COMPLIANT_FIELDS,
        latencyMs: 100,
        modelId: "mock:trace",
        modelVersion: "mock-v1",
        promptHash: "deadbeefdeadbeef",
        cost: { inputTokens: 100, outputTokens: 50, costUsd: 0.000001 },
      };
    },
  };
}

describe("verifyLabel — recordTrace sink", () => {
  it("invokes the sink exactly once with a fully-populated trace", async () => {
    const captured: VerifyTrace[] = [];
    await verifyLabel(
      await tinyJpeg(),
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
      {
        extractor: compliantExtractor(),
        recordTrace: (t) => captured.push(t),
      },
    );
    expect(captured).toHaveLength(1);
    const t = captured[0]!;
    expect(typeof t.id).toBe("string");
    expect(t.id.length).toBeGreaterThan(0);
    expect(t.receivedAt).toBeGreaterThan(0);
    expect(t.modelId).toBe("mock:trace");
    expect(t.modelVersion).toBe("mock-v1");
    expect(t.promptHash).toBe("deadbeefdeadbeef");
    expect(t.preprocessedDims.w).toBeGreaterThan(0);
    expect(t.preprocessedDims.h).toBeGreaterThan(0);
    expect(t.declared.brand_name).toBe("Stone's Throw Brewing");
    expect(t.response.verdict).toBe("pass");
  });

  it("swallows a throwing sink — verify still returns a valid response", async () => {
    const throwingSink = vi.fn(() => {
      throw new Error("intentional sink failure");
    });
    const response = await verifyLabel(
      await tinyJpeg(),
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
      {
        extractor: compliantExtractor(),
        recordTrace: throwingSink,
      },
    );
    expect(throwingSink).toHaveBeenCalledOnce();
    expect(response.verdict).toBe("pass");
  });
});
