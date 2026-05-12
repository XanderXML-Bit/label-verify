import { describe, it, expect, vi, beforeEach } from "vitest";
import type { ExtractedFields } from "@/lib/vision/types";

// ─── SDK mocks ──────────────────────────────────────────────────────────────
//
// Same pattern as extractors.test.ts: stub the three SDKs at the top of the
// file so vi.mock's hoisting catches them before adapters import them. The
// mocks record the last call so each test can assert on the request shape.

const openaiCreate = vi.fn();
const anthropicCreate = vi.fn();
const geminiGenerateContent = vi.fn();

vi.mock("openai", () => {
  return {
    default: class OpenAIMock {
      chat: { completions: { create: typeof openaiCreate } };
      constructor() {
        this.chat = { completions: { create: openaiCreate } };
      }
    },
  };
});

vi.mock("@anthropic-ai/sdk", () => {
  return {
    default: class AnthropicMock {
      messages: { create: typeof anthropicCreate };
      constructor() {
        this.messages = { create: anthropicCreate };
      }
    },
  };
});

// The Gemini SDK exposes a SchemaType enum that the adapter imports at
// module level — preserve it as a real object so the adapter's RESPONSE_SCHEMA
// translation still works under the mock.
vi.mock("@google/generative-ai", () => {
  return {
    GoogleGenerativeAI: class GoogleGenAIMock {
      constructor(_apiKey: string) {}
      getGenerativeModel(_opts: unknown) {
        return { generateContent: geminiGenerateContent };
      }
    },
    SchemaType: {
      OBJECT: "object",
      STRING: "string",
      NUMBER: "number",
      BOOLEAN: "boolean",
      ARRAY: "array",
      INTEGER: "integer",
    },
  };
});

// Import AFTER vi.mock so the adapters pick up the mocked classes.
const { GPT4oFullExtractor } = await import("@/lib/vision/openai");
const { ClaudeHaikuExtractor } = await import("@/lib/vision/anthropic");
const { GeminiFlashFullExtractor, GeminiProExtractor } = await import(
  "@/lib/vision/gemini"
);

beforeEach(() => {
  openaiCreate.mockReset();
  anthropicCreate.mockReset();
  geminiGenerateContent.mockReset();
});

// ─── Test fixtures ──────────────────────────────────────────────────────────

const FIELDS: ExtractedFields = {
  brand_name: { value: "Test Brewery", confidence: 0.9 },
  class_type: { value: "IPA", confidence: 0.9 },
  abv_percent: { value: 5.5, confidence: 0.9 },
  net_contents: { value: { value: 355, unit: "ml" }, confidence: 0.9 },
  government_warning: {
    value: {
      raw_text: "GOVERNMENT WARNING: ...",
      prefix_text: "GOVERNMENT WARNING",
      prefix_bbox: { x: 0, y: 0, width: 10, height: 10 },
      prefix_appears_bold: true,
      prefix_appears_caps: true,
    },
    confidence: 0.85,
  },
  producer: {
    value: {
      name: "Test Brewery",
      street: null,
      city: null,
      state: null,
      postal_code: null,
      country: null,
    },
    confidence: 0.8,
  },
  country_of_origin: { value: "USA", confidence: 0.9 },
};

const TINY_IMAGE = Buffer.from([0xff, 0xd8, 0xff, 0xd9]);

function openaiOk() {
  return {
    choices: [{ message: { content: JSON.stringify(FIELDS) } }],
    usage: { prompt_tokens: 1000, completion_tokens: 300 },
  };
}

function anthropicOk() {
  return {
    content: [{ type: "text", text: JSON.stringify(FIELDS) }],
    usage: { input_tokens: 1200, output_tokens: 250 },
  };
}

function geminiOk() {
  return {
    response: {
      text: () => JSON.stringify(FIELDS),
      usageMetadata: { promptTokenCount: 800, candidatesTokenCount: 200 },
    },
  };
}

// ─── GeminiFlashFullExtractor (T6b) ─────────────────────────────────────────

describe("GeminiFlashFullExtractor", () => {
  it("instantiates with an apiKey and rejects missing apiKey", () => {
    expect(() => new GeminiFlashFullExtractor({ apiKey: "test-key" })).not.toThrow();
    expect(() => new GeminiFlashFullExtractor({ apiKey: "" })).toThrow(
      /missing apiKey/,
    );
  });

  it("extract() returns ExtractorResult with Flash-tier costing and correct modelVersion", async () => {
    geminiGenerateContent.mockResolvedValueOnce(geminiOk());
    const ext = new GeminiFlashFullExtractor({ apiKey: "test-key" });
    const result = await ext.extract(TINY_IMAGE);

    expect(result.modelVersion).toBe("gemini-2.5-flash");
    expect(result.modelId).toBe("gemini:gemini-2.5-flash");
    expect(result.promptHash).toMatch(/^[0-9a-f]{16}$/);
    expect(result.cost.inputTokens).toBe(800);
    expect(result.cost.outputTokens).toBe(200);
    // Flash pricing: 800/1M * 0.075 + 200/1M * 0.300 = 0.00006 + 0.00006 = 0.00012
    expect(result.cost.costUsd).toBeGreaterThan(0);
    expect(result.cost.costUsd).toBeCloseTo(0.00012, 6);
    expect(result.fields.brand_name.value).toBe("Test Brewery");
  });

  it("respects AbortSignal", async () => {
    geminiGenerateContent.mockImplementation(() => new Promise(() => {}));
    const ext = new GeminiFlashFullExtractor({ apiKey: "test-key" });
    const ctrl = new AbortController();
    ctrl.abort();
    await expect(
      ext.extract(TINY_IMAGE, { signal: ctrl.signal }),
    ).rejects.toMatchObject({ name: "AbortError" });
  });
});

// ─── GeminiProExtractor (T6c) ───────────────────────────────────────────────

describe("GeminiProExtractor", () => {
  it("instantiates with an apiKey and rejects missing apiKey", () => {
    expect(() => new GeminiProExtractor({ apiKey: "test-key" })).not.toThrow();
    expect(() => new GeminiProExtractor({ apiKey: "" })).toThrow(/missing apiKey/);
  });

  it("extract() returns ExtractorResult with Pro-tier costing and correct modelVersion", async () => {
    geminiGenerateContent.mockResolvedValueOnce(geminiOk());
    const ext = new GeminiProExtractor({ apiKey: "test-key" });
    const result = await ext.extract(TINY_IMAGE);

    // Default bumped 2026-05-12 to gemini-3.1-pro-preview after live
    // probe confirmed (-preview is the only Pro-tier 3.1 SKU that
    // responds; the bare gemini-3.1-pro returns 404).
    expect(result.modelVersion).toBe("gemini-3.1-pro-preview");
    expect(result.modelId).toBe("gemini:gemini-3.1-pro-preview");
    expect(result.cost.inputTokens).toBe(800);
    expect(result.cost.outputTokens).toBe(200);
    // Pro pricing: 800/1M * 1.25 + 200/1M * 5.00 = 0.001 + 0.001 = 0.002
    expect(result.cost.costUsd).toBeCloseTo(0.002, 6);
    // And it MUST be more expensive than Flash on the same usage.
    expect(result.cost.costUsd).toBeGreaterThan(0.00012);
  });

  it("respects AbortSignal", async () => {
    geminiGenerateContent.mockImplementation(() => new Promise(() => {}));
    const ext = new GeminiProExtractor({ apiKey: "test-key" });
    const ctrl = new AbortController();
    ctrl.abort();
    await expect(
      ext.extract(TINY_IMAGE, { signal: ctrl.signal }),
    ).rejects.toMatchObject({ name: "AbortError" });
  });
});

// ─── GPT4oFullExtractor (T4b) ───────────────────────────────────────────────

describe("GPT4oFullExtractor", () => {
  it("instantiates with an apiKey and rejects missing apiKey", () => {
    expect(() => new GPT4oFullExtractor({ apiKey: "test-key" })).not.toThrow();
    expect(() => new GPT4oFullExtractor({ apiKey: "" })).toThrow(/missing apiKey/);
  });

  it("extract() returns ExtractorResult with GPT-4o-full costing and modelVersion", async () => {
    openaiCreate.mockResolvedValueOnce(openaiOk());
    const ext = new GPT4oFullExtractor({ apiKey: "test-key" });
    const result = await ext.extract(TINY_IMAGE);

    // Default bumped 2026-05-12 to gpt-5 per user directive. Older
    // gpt-4o default still available via modelVersion override.
    expect(result.modelVersion).toBe("gpt-5");
    expect(result.modelId).toBe("openai:gpt-5");
    expect(result.cost.inputTokens).toBe(1000);
    expect(result.cost.outputTokens).toBe(300);
    // gpt-5 pricing: 1000/1M * 1.25 + 300/1M * 10 = 0.00125 + 0.003 = 0.00425
    expect(result.cost.costUsd).toBeCloseTo(0.00425, 6);

    // Also assert request shape uses the same strict json_schema mode.
    const callArg = openaiCreate.mock.calls[0]?.[0];
    expect(callArg.model).toBe("gpt-5");
    expect(callArg.response_format.type).toBe("json_schema");
    expect(callArg.response_format.json_schema.strict).toBe(true);
    // GPT-5 series rejects custom temperature; the adapter must not
    // send one. (See src/lib/vision/openai.ts `isGpt5` branch.)
    expect(callArg.temperature).toBeUndefined();
  });

  it("respects AbortSignal", async () => {
    openaiCreate.mockImplementation(() => new Promise(() => {}));
    const ext = new GPT4oFullExtractor({ apiKey: "test-key" });
    const ctrl = new AbortController();
    ctrl.abort();
    await expect(
      ext.extract(TINY_IMAGE, { signal: ctrl.signal }),
    ).rejects.toMatchObject({ name: "AbortError" });
  });
});

// ─── ClaudeHaikuExtractor (T5b) ─────────────────────────────────────────────

describe("ClaudeHaikuExtractor", () => {
  it("instantiates with an apiKey and rejects missing apiKey", () => {
    expect(() => new ClaudeHaikuExtractor({ apiKey: "test-key" })).not.toThrow();
    expect(() => new ClaudeHaikuExtractor({ apiKey: "" })).toThrow(
      /missing apiKey/,
    );
  });

  it("extract() returns ExtractorResult with Haiku costing and modelVersion", async () => {
    anthropicCreate.mockResolvedValueOnce(anthropicOk());
    const ext = new ClaudeHaikuExtractor({ apiKey: "test-key" });
    const result = await ext.extract(TINY_IMAGE);

    expect(result.modelVersion).toBe("claude-haiku-4-5");
    expect(result.modelId).toBe("anthropic:claude-haiku-4-5");
    expect(result.cost.inputTokens).toBe(1200);
    expect(result.cost.outputTokens).toBe(250);
    // Haiku pricing: 1200/1M * 1 + 250/1M * 5 = 0.0012 + 0.00125 = 0.00245
    expect(result.cost.costUsd).toBeCloseTo(0.00245, 6);

    // Also confirm the image arrives as a base64 image block.
    const callArg = anthropicCreate.mock.calls[0]?.[0];
    expect(callArg.model).toBe("claude-haiku-4-5");
    const content = callArg.messages[0].content;
    const imgBlock = content.find((b: { type: string }) => b.type === "image");
    expect(imgBlock.source.data).toBe(TINY_IMAGE.toString("base64"));
  });

  it("respects AbortSignal", async () => {
    anthropicCreate.mockImplementation(() => new Promise(() => {}));
    const ext = new ClaudeHaikuExtractor({ apiKey: "test-key" });
    const ctrl = new AbortController();
    ctrl.abort();
    await expect(
      ext.extract(TINY_IMAGE, { signal: ctrl.signal }),
    ).rejects.toMatchObject({ name: "AbortError" });
  });
});
