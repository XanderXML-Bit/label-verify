// Wave-32 audit pin (Sub-agent B G1): cross-provider fallback path
// (verify.ts lines 222-293) was completely untested. The path is the
// system's only protection against a full Gemini provider outage and
// includes three security-relevant branches:
//   (a) no `OPENAI_API_KEY` → re-throw primary err
//   (b) `externalAbort.aborted` before fallback fires → skip and re-throw
//   (c) fallback also throws → re-throw primary (more diagnostic)
//
// We mock `@/lib/vision/openai`'s `GPT4oMiniExtractor` so the fallback
// pathway runs without a real OpenAI key.

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import sharp from "sharp";
import type {
  Extractor,
  ExtractorResult,
  ExtractedFields,
} from "@/lib/vision/types";

// Mock OCR (same pattern as verify.test.ts)
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

// Mock the OpenAI extractor module that the fallback path loads.
const fallbackExtractMock = vi.fn();
vi.mock("@/lib/vision/openai", () => ({
  GPT4oMiniExtractor: vi.fn().mockImplementation(() => ({
    id: "mock:openai-fallback",
    networkRequired: true,
    extract: fallbackExtractMock,
  })),
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

const DECLARED = {
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

function throwingPrimary(message: string): Extractor {
  return {
    id: "mock:throwing-primary",
    networkRequired: true,
    async extract(): Promise<ExtractorResult> {
      throw new Error(message);
    },
  };
}

describe("verifyLabel — cross-provider fallback (G1 audit pin)", () => {
  const originalOpenAiKey = process.env.OPENAI_API_KEY;
  const originalFallbackModel = process.env.MODEL_FALLBACK;

  beforeEach(() => {
    fallbackExtractMock.mockReset();
  });

  afterEach(() => {
    if (originalOpenAiKey === undefined) delete process.env.OPENAI_API_KEY;
    else process.env.OPENAI_API_KEY = originalOpenAiKey;
    if (originalFallbackModel === undefined) delete process.env.MODEL_FALLBACK;
    else process.env.MODEL_FALLBACK = originalFallbackModel;
  });

  it("primary fails + OPENAI_API_KEY set → fallback fires, fallbackUsed populated", async () => {
    process.env.OPENAI_API_KEY = "sk-test-fallback";
    process.env.MODEL_FALLBACK = "gpt-5.4-nano";
    fallbackExtractMock.mockResolvedValue({
      fields: COMPLIANT_FIELDS,
      rawOutput: COMPLIANT_FIELDS,
      latencyMs: 200,
      modelId: "gpt-5.4-nano",
      modelVersion: "gpt-5.4-nano",
      promptHash: "fbhashfbhashfb",
      cost: { inputTokens: 100, outputTokens: 50, costUsd: 0.000002 },
    });
    // Reset modules so the mock above is picked up.
    vi.resetModules();
    const { verifyLabel } = await import("@/lib/verify");
    const result = await verifyLabel(await tinyJpeg(), DECLARED, {
      extractor: throwingPrimary("primary 503"),
    });
    expect(result.fallbackUsed).toBe("gpt-5.4-nano");
    expect(result.verdict).toBe("pass");
    expect(fallbackExtractMock).toHaveBeenCalledOnce();
  });

  it("primary fails + no OPENAI_API_KEY → rethrows primary err, fallback never tried", async () => {
    delete process.env.OPENAI_API_KEY;
    vi.resetModules();
    const { verifyLabel } = await import("@/lib/verify");
    await expect(
      verifyLabel(await tinyJpeg(), DECLARED, {
        extractor: throwingPrimary("primary 500"),
      }),
    ).rejects.toThrow(/primary 500/);
    expect(fallbackExtractMock).not.toHaveBeenCalled();
  });

  it("primary fails + externalAbort already aborted → skip fallback (security: no wasted call)", async () => {
    process.env.OPENAI_API_KEY = "sk-test-fallback";
    vi.resetModules();
    const { verifyLabel } = await import("@/lib/verify");
    const abortCtrl = new AbortController();
    abortCtrl.abort();
    await expect(
      verifyLabel(await tinyJpeg(), DECLARED, {
        extractor: throwingPrimary("primary 503"),
        abortSignal: abortCtrl.signal,
      }),
    ).rejects.toThrow(/primary 503/);
    expect(fallbackExtractMock).not.toHaveBeenCalled();
  });

  it("primary fails + fallback also fails → primary error wins (more diagnostic)", async () => {
    process.env.OPENAI_API_KEY = "sk-test-fallback";
    fallbackExtractMock.mockRejectedValue(new Error("fallback 502"));
    vi.resetModules();
    const { verifyLabel } = await import("@/lib/verify");
    await expect(
      verifyLabel(await tinyJpeg(), DECLARED, {
        extractor: throwingPrimary("PRIMARY-OUTAGE"),
      }),
    ).rejects.toThrow(/PRIMARY-OUTAGE/);
    expect(fallbackExtractMock).toHaveBeenCalledOnce();
  });
});
