import { describe, it, expect, vi, beforeEach } from "vitest";
import type {
  ExtractedFields,
  Extractor,
  ExtractorContext,
  ExtractorResult,
} from "@/lib/vision/types";

// ─── SDK mocks ──────────────────────────────────────────────────────────────
//
// We mock the SDK modules at the top of the file so vi.mock's hoisting
// catches them before either adapter is imported. The mocks record the
// last call so each test can assert on the request shape.

const openaiCreate = vi.fn();
const anthropicCreate = vi.fn();

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

// Import AFTER vi.mock so the adapters pick up the mocked classes.
const { GPT4oMiniExtractor } = await import("@/lib/vision/openai");
const { ClaudeSonnetExtractor } = await import("@/lib/vision/anthropic");
const { TieredEscalationExtractor } = await import("@/lib/vision/tiered");

beforeEach(() => {
  openaiCreate.mockReset();
  anthropicCreate.mockReset();
});

// ─── Test fixtures ──────────────────────────────────────────────────────────

const HIGH_CONFIDENCE_FIELDS: ExtractedFields = {
  brand_name: { value: "Stone's Throw", confidence: 0.95 },
  class_type: { value: "IPA", confidence: 0.9 },
  abv_percent: { value: 6.4, confidence: 0.9 },
  net_contents: { value: { value: 12, unit: "fl_oz" }, confidence: 0.9 },
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
      name: "Stone's Throw Brewing Co.",
      street: null,
      city: null,
      state: null,
      postal_code: null,
      country: null,
    },
    confidence: 0.8,
  },
  country_of_origin: { value: "USA", confidence: 0.95 },
};

const LOW_CONFIDENCE_FIELDS: ExtractedFields = {
  ...HIGH_CONFIDENCE_FIELDS,
  // Drop one field below the default threshold (0.65).
  brand_name: { value: "Stone's Throw", confidence: 0.4 },
};

const TINY_IMAGE = Buffer.from([0xff, 0xd8, 0xff, 0xd9]); // jpeg SOI/EOI

function fakeOpenAIResponse(fields: ExtractedFields) {
  return {
    choices: [{ message: { content: JSON.stringify(fields) } }],
    usage: { prompt_tokens: 1000, completion_tokens: 300 },
  };
}

function fakeAnthropicResponse(fields: ExtractedFields) {
  return {
    content: [{ type: "text", text: JSON.stringify(fields) }],
    usage: { input_tokens: 1200, output_tokens: 250 },
  };
}

// ─── OpenAI adapter ─────────────────────────────────────────────────────────

describe("GPT4oMiniExtractor", () => {
  it("sends a request with the right model + response_format shape", async () => {
    openaiCreate.mockResolvedValueOnce(
      fakeOpenAIResponse(HIGH_CONFIDENCE_FIELDS),
    );
    // Pin the legacy gpt-4o-mini model so the temperature=0 assertion
    // holds. The new default is gpt-5-nano which doesn't accept
    // temperature; that path is covered in extractors-extended.test.ts.
    const ext = new GPT4oMiniExtractor({
      apiKey: "test-key",
      modelVersion: "gpt-4o-mini-2024-07-18",
    });
    const result = await ext.extract(TINY_IMAGE);

    expect(openaiCreate).toHaveBeenCalledTimes(1);
    const callArg = openaiCreate.mock.calls[0]?.[0];
    expect(callArg).toBeDefined();
    expect(callArg.model).toBe("gpt-4o-mini-2024-07-18");
    expect(callArg.temperature).toBe(0);
    expect(callArg.response_format).toBeDefined();
    expect(callArg.response_format.type).toBe("json_schema");
    expect(callArg.response_format.json_schema.strict).toBe(true);
    expect(callArg.response_format.json_schema.name).toBe(
      "extracted_label_fields",
    );
    expect(callArg.response_format.json_schema.schema.type).toBe("object");
    // Strict mode requires additionalProperties: false on every object.
    expect(callArg.response_format.json_schema.schema.additionalProperties).toBe(
      false,
    );

    // Image must arrive as an image_url content block with a data URL.
    const userMsg = callArg.messages[0];
    expect(userMsg.role).toBe("user");
    const imgPart = userMsg.content.find(
      (p: { type: string }) => p.type === "image_url",
    );
    expect(imgPart).toBeDefined();
    expect(imgPart.image_url.url).toMatch(/^data:image\/jpeg;base64,/);

    // Result fields parsed cleanly.
    expect(result.fields.brand_name.value).toBe("Stone's Throw");
    expect(result.cost.inputTokens).toBe(1000);
    expect(result.cost.outputTokens).toBe(300);
    expect(result.modelId).toBe("openai:gpt-4o-mini-2024-07-18");
  });

  it("includes OCR text in the prompt when provided", async () => {
    openaiCreate.mockResolvedValueOnce(
      fakeOpenAIResponse(HIGH_CONFIDENCE_FIELDS),
    );
    const ext = new GPT4oMiniExtractor({ apiKey: "test-key" });
    await ext.extract(TINY_IMAGE, { ocrText: "HINT TEXT FROM OCR" });

    const callArg = openaiCreate.mock.calls[0]?.[0];
    const textPart = callArg.messages[0].content.find(
      (p: { type: string }) => p.type === "text",
    );
    expect(textPart.text).toContain("HINT TEXT FROM OCR");
  });

  it("respects AbortSignal — rejects with AbortError when signal is pre-aborted", async () => {
    // The SDK call would normally pend forever; the abort race should win.
    openaiCreate.mockImplementation(() => new Promise(() => {}));
    const ext = new GPT4oMiniExtractor({ apiKey: "test-key" });
    const ctrl = new AbortController();
    ctrl.abort();
    await expect(
      ext.extract(TINY_IMAGE, { signal: ctrl.signal }),
    ).rejects.toMatchObject({ name: "AbortError" });
  });
});

// ─── Anthropic adapter ──────────────────────────────────────────────────────

describe("ClaudeSonnetExtractor", () => {
  it("sends a base64 image in a content block", async () => {
    anthropicCreate.mockResolvedValueOnce(
      fakeAnthropicResponse(HIGH_CONFIDENCE_FIELDS),
    );
    const ext = new ClaudeSonnetExtractor({ apiKey: "test-key" });
    const result = await ext.extract(TINY_IMAGE);

    expect(anthropicCreate).toHaveBeenCalledTimes(1);
    const callArg = anthropicCreate.mock.calls[0]?.[0];
    expect(callArg).toBeDefined();
    expect(callArg.model).toBe("claude-sonnet-4-6");
    expect(callArg.temperature).toBe(0);

    const content = callArg.messages[0].content;
    const imgBlock = content.find((b: { type: string }) => b.type === "image");
    expect(imgBlock).toBeDefined();
    expect(imgBlock.source.type).toBe("base64");
    expect(imgBlock.source.media_type).toBe("image/jpeg");
    expect(imgBlock.source.data).toBe(TINY_IMAGE.toString("base64"));

    // Result fields parsed cleanly.
    expect(result.fields.brand_name.value).toBe("Stone's Throw");
    expect(result.cost.inputTokens).toBe(1200);
    expect(result.cost.outputTokens).toBe(250);
    expect(result.modelId).toBe("anthropic:claude-sonnet-4-6");
  });

  it("respects AbortSignal — rejects with AbortError when signal is pre-aborted", async () => {
    anthropicCreate.mockImplementation(() => new Promise(() => {}));
    const ext = new ClaudeSonnetExtractor({ apiKey: "test-key" });
    const ctrl = new AbortController();
    ctrl.abort();
    await expect(
      ext.extract(TINY_IMAGE, { signal: ctrl.signal }),
    ).rejects.toMatchObject({ name: "AbortError" });
  });
});

// ─── Tiered orchestrator ────────────────────────────────────────────────────

function buildFakeExtractor(
  id: string,
  fields: ExtractedFields,
  latencyMs = 50,
): Extractor & { calls: number } {
  const obj = {
    id,
    networkRequired: true,
    calls: 0,
    async extract(
      _image: Buffer,
      _ctx?: ExtractorContext,
    ): Promise<ExtractorResult> {
      obj.calls += 1;
      return {
        fields,
        rawOutput: { from: id },
        latencyMs,
        modelId: id,
        modelVersion: id,
        promptHash: "deadbeefdeadbeef",
        cost: { inputTokens: 10, outputTokens: 5, costUsd: 0.001 },
      };
    },
  };
  return obj;
}

describe("TieredEscalationExtractor", () => {
  it("returns the fast result when min-confidence is high", async () => {
    const fast = buildFakeExtractor("fast", HIGH_CONFIDENCE_FIELDS, 40);
    const strong = buildFakeExtractor("strong", HIGH_CONFIDENCE_FIELDS, 400);
    const tiered = new TieredEscalationExtractor({ fast, strong });

    const result = await tiered.extract(TINY_IMAGE);
    expect(fast.calls).toBe(1);
    expect(strong.calls).toBe(0);
    expect(result.modelId).toBe("fast");
    expect(result.latencyMs).toBe(40);
    // Fast path: rawOutput is the fast result's rawOutput, not escalation metadata.
    expect((result.rawOutput as { from?: string }).from).toBe("fast");
  });

  it("escalates and surfaces metadata when min-confidence is low", async () => {
    const fast = buildFakeExtractor("fast", LOW_CONFIDENCE_FIELDS, 40);
    const strong = buildFakeExtractor("strong", HIGH_CONFIDENCE_FIELDS, 400);
    const tiered = new TieredEscalationExtractor({ fast, strong });

    const result = await tiered.extract(TINY_IMAGE);
    expect(fast.calls).toBe(1);
    expect(strong.calls).toBe(1);
    // Latency is the SUM of fast + strong.
    expect(result.latencyMs).toBe(440);
    // Fields come from the strong tier.
    expect(result.fields.brand_name.confidence).toBe(0.95);
    // Escalation metadata surfaced via rawOutput.
    const raw = result.rawOutput as {
      escalated: boolean;
      fastConfidence: number;
      fastResult: ExtractorResult;
      strongResult: unknown;
    };
    expect(raw.escalated).toBe(true);
    expect(raw.fastConfidence).toBe(0.4);
    expect(raw.fastResult.modelId).toBe("fast");
    // Costs accumulate.
    expect(result.cost.inputTokens).toBe(20);
    expect(result.cost.outputTokens).toBe(10);
  });

  it("respects a custom confidenceThreshold", async () => {
    // Same low-confidence fields, but threshold relaxed below 0.4 — no escalation.
    const fast = buildFakeExtractor("fast", LOW_CONFIDENCE_FIELDS, 40);
    const strong = buildFakeExtractor("strong", HIGH_CONFIDENCE_FIELDS, 400);
    const tiered = new TieredEscalationExtractor({
      fast,
      strong,
      confidenceThreshold: 0.3,
    });

    const result = await tiered.extract(TINY_IMAGE);
    expect(strong.calls).toBe(0);
    expect(result.modelId).toBe("fast");
  });

  it("respects AbortSignal — pre-aborted before fast call", async () => {
    const fast = buildFakeExtractor("fast", HIGH_CONFIDENCE_FIELDS, 40);
    const strong = buildFakeExtractor("strong", HIGH_CONFIDENCE_FIELDS, 400);
    const tiered = new TieredEscalationExtractor({ fast, strong });

    const ctrl = new AbortController();
    ctrl.abort();
    await expect(
      tiered.extract(TINY_IMAGE, { signal: ctrl.signal }),
    ).rejects.toMatchObject({ name: "AbortError" });
    expect(fast.calls).toBe(0);
  });

  it("respects AbortSignal — aborted between fast and strong", async () => {
    const ctrl = new AbortController();
    const fast: Extractor = {
      id: "fast",
      networkRequired: true,
      async extract(): Promise<ExtractorResult> {
        // Simulate cancellation arriving right as the fast call returns.
        ctrl.abort();
        return {
          fields: LOW_CONFIDENCE_FIELDS,
          rawOutput: { from: "fast" },
          latencyMs: 40,
          modelId: "fast",
          modelVersion: "fast",
          promptHash: "deadbeefdeadbeef",
          cost: { inputTokens: 0, outputTokens: 0, costUsd: 0 },
        };
      },
    };
    const strong = buildFakeExtractor("strong", HIGH_CONFIDENCE_FIELDS, 400);
    const tiered = new TieredEscalationExtractor({ fast, strong });

    await expect(
      tiered.extract(TINY_IMAGE, { signal: ctrl.signal }),
    ).rejects.toMatchObject({ name: "AbortError" });
    expect(strong.calls).toBe(0);
  });
});
