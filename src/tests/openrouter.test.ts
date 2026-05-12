import { describe, it, expect, vi, beforeEach } from "vitest";
import type { ExtractedFields } from "@/lib/vision/types";

// ─── SDK mock ───────────────────────────────────────────────────────────────
//
// OpenRouter uses the same OpenAI-compatible REST shape as openai.com, so
// the adapter reaches it through the `openai` SDK with a custom baseURL.
// We capture the constructor options (to assert baseURL + headers) and the
// chat.completions.create call (to assert request shape + structured-output
// behaviour).

const openrouterCreate = vi.fn();
const constructorCalls: Array<Record<string, unknown>> = [];

vi.mock("openai", () => {
  return {
    default: class OpenAIMock {
      chat: { completions: { create: typeof openrouterCreate } };
      constructor(opts: Record<string, unknown>) {
        constructorCalls.push(opts);
        this.chat = { completions: { create: openrouterCreate } };
      }
    },
  };
});

// Import AFTER vi.mock so the adapter picks up the mocked class.
const { OpenRouterExtractor } = await import("@/lib/vision/openrouter");

beforeEach(() => {
  openrouterCreate.mockReset();
  constructorCalls.length = 0;
});

// ─── Test fixtures ──────────────────────────────────────────────────────────

const FIELDS: ExtractedFields = {
  brand_name: { value: "Frontier Lager", confidence: 0.92 },
  class_type: { value: "Lager", confidence: 0.9 },
  abv_percent: { value: 4.5, confidence: 0.92 },
  net_contents: { value: { value: 355, unit: "ml" }, confidence: 0.9 },
  government_warning: {
    value: {
      raw_text: "GOVERNMENT WARNING: ...",
      prefix_text: "GOVERNMENT WARNING",
      prefix_bbox: { x: 1, y: 2, width: 30, height: 8 },
      prefix_appears_bold: true,
      prefix_appears_caps: true,
    },
    confidence: 0.88,
  },
  producer: {
    value: {
      name: "Frontier Brewing Co.",
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

const TINY_IMAGE = Buffer.from([0xff, 0xd8, 0xff, 0xd9]);

function openrouterOk(body: string) {
  return {
    choices: [{ message: { content: body } }],
    usage: { prompt_tokens: 1500, completion_tokens: 400 },
  };
}

// ─── Constructor wiring ─────────────────────────────────────────────────────

describe("OpenRouterExtractor — wiring", () => {
  it("rejects missing apiKey", () => {
    expect(
      () =>
        new OpenRouterExtractor({
          apiKey: "",
          modelSlug: "openai/gpt-5",
          pricing: { inputPer1M: 5, outputPer1M: 20 },
        }),
    ).toThrow(/missing apiKey/);
  });

  it("rejects missing modelSlug", () => {
    expect(
      () =>
        new OpenRouterExtractor({
          apiKey: "test-key",
          modelSlug: "",
          pricing: { inputPer1M: 5, outputPer1M: 20 },
        }),
    ).toThrow(/missing modelSlug/);
  });

  it("instantiates the openai SDK with the OpenRouter baseURL", () => {
    new OpenRouterExtractor({
      apiKey: "or-test-key",
      modelSlug: "google/gemini-3-flash-lite-preview",
      pricing: { inputPer1M: 0.1, outputPer1M: 0.4 },
    });
    expect(constructorCalls.length).toBe(1);
    const ctor = constructorCalls[0]!;
    expect(ctor.apiKey).toBe("or-test-key");
    expect(ctor.baseURL).toBe("https://openrouter.ai/api/v1");
  });

  it("forwards optional appReferer + appTitle headers when supplied", () => {
    new OpenRouterExtractor({
      apiKey: "or-test-key",
      modelSlug: "openai/gpt-5",
      pricing: { inputPer1M: 5, outputPer1M: 20 },
      appReferer: "https://example.invalid",
      appTitle: "LabelVerify",
    });
    const ctor = constructorCalls[0]!;
    expect(ctor.defaultHeaders).toMatchObject({
      "HTTP-Referer": "https://example.invalid",
      "X-Title": "LabelVerify",
    });
  });

  it("modelId carries the openrouter: prefix and the slug", () => {
    const ext = new OpenRouterExtractor({
      apiKey: "or-test-key",
      modelSlug: "openai/gpt-5",
      pricing: { inputPer1M: 5, outputPer1M: 20 },
    });
    expect(ext.id).toBe("openrouter:openai/gpt-5");
  });
});

// ─── Structured-output path (json_schema strict mode) ───────────────────────

describe("OpenRouterExtractor — structured output enabled", () => {
  it("attaches response_format.json_schema when structuredOutput=true", async () => {
    openrouterCreate.mockResolvedValueOnce(
      openrouterOk(JSON.stringify(FIELDS)),
    );
    const ext = new OpenRouterExtractor({
      apiKey: "or-test-key",
      modelSlug: "google/gemini-3-pro-preview",
      pricing: { inputPer1M: 2.5, outputPer1M: 10 },
      structuredOutput: true,
    });
    const result = await ext.extract(TINY_IMAGE);

    expect(openrouterCreate).toHaveBeenCalledTimes(1);
    const callArg = openrouterCreate.mock.calls[0]?.[0];
    expect(callArg).toBeDefined();
    expect(callArg.model).toBe("google/gemini-3-pro-preview");
    expect(callArg.temperature).toBe(0);
    expect(callArg.response_format).toBeDefined();
    expect(callArg.response_format.type).toBe("json_schema");
    expect(callArg.response_format.json_schema.strict).toBe(true);
    expect(callArg.response_format.json_schema.name).toBe(
      "extracted_label_fields",
    );
    // The schema must mark the root object as no-extra-properties for
    // strict-mode upstream models.
    expect(
      callArg.response_format.json_schema.schema.additionalProperties,
    ).toBe(false);

    // Image arrives as an image_url block with a data URL.
    const userMsg = callArg.messages[0];
    expect(userMsg.role).toBe("user");
    const imgPart = userMsg.content.find(
      (p: { type: string }) => p.type === "image_url",
    );
    expect(imgPart).toBeDefined();
    expect(imgPart.image_url.url).toMatch(/^data:image\/jpeg;base64,/);

    // Result fields parsed cleanly.
    expect(result.fields.brand_name.value).toBe("Frontier Lager");
    expect(result.modelId).toBe("openrouter:google/gemini-3-pro-preview");
    expect(result.modelVersion).toBe("google/gemini-3-pro-preview");
    expect(result.promptHash).toMatch(/^[0-9a-f]{16}$/);
  });

  it("records cost from usage tokens × supplied pricing", async () => {
    openrouterCreate.mockResolvedValueOnce(
      openrouterOk(JSON.stringify(FIELDS)),
    );
    const ext = new OpenRouterExtractor({
      apiKey: "or-test-key",
      modelSlug: "openai/gpt-5",
      // Use deliberately weird rates so the assertion isn't ambiguous.
      pricing: { inputPer1M: 7, outputPer1M: 13 },
      structuredOutput: true,
    });
    const result = await ext.extract(TINY_IMAGE);

    expect(result.cost.inputTokens).toBe(1500);
    expect(result.cost.outputTokens).toBe(400);
    // 1500/1M * 7 + 400/1M * 13 = 0.0105 + 0.0052 = 0.0157
    expect(result.cost.costUsd).toBeCloseTo(0.0157, 6);
  });

  it("uses the supplied modelVersion when provided", async () => {
    openrouterCreate.mockResolvedValueOnce(
      openrouterOk(JSON.stringify(FIELDS)),
    );
    const ext = new OpenRouterExtractor({
      apiKey: "or-test-key",
      modelSlug: "openai/gpt-5",
      modelVersion: "openai/gpt-5-2026-04-01",
      pricing: { inputPer1M: 5, outputPer1M: 20 },
      structuredOutput: true,
    });
    const result = await ext.extract(TINY_IMAGE);
    expect(result.modelVersion).toBe("openai/gpt-5-2026-04-01");
  });
});

// ─── Fallback path (manual JSON parse) ──────────────────────────────────────

describe("OpenRouterExtractor — structured output disabled (fallback)", () => {
  it("omits response_format when structuredOutput=false", async () => {
    openrouterCreate.mockResolvedValueOnce(
      openrouterOk(JSON.stringify(FIELDS)),
    );
    const ext = new OpenRouterExtractor({
      apiKey: "or-test-key",
      modelSlug: "openai/gpt-oss-120b",
      pricing: { inputPer1M: 0.3, outputPer1M: 0.5 },
      // structuredOutput omitted → defaults to false
    });
    await ext.extract(TINY_IMAGE);

    const callArg = openrouterCreate.mock.calls[0]?.[0];
    expect(callArg.response_format).toBeUndefined();
    // The "respond in JSON only" suffix is appended to the prompt instead.
    const textPart = callArg.messages[0].content.find(
      (p: { type: string }) => p.type === "text",
    );
    expect(textPart.text).toContain('first character of your response must be "{"');
  });

  it("strips ```json fences before parsing (Gemini-via-OpenRouter quirk)", async () => {
    const fenced = "```json\n" + JSON.stringify(FIELDS) + "\n```";
    openrouterCreate.mockResolvedValueOnce(openrouterOk(fenced));
    const ext = new OpenRouterExtractor({
      apiKey: "or-test-key",
      modelSlug: "mistralai/pixtral-large-latest",
      pricing: { inputPer1M: 2, outputPer1M: 6 },
      structuredOutput: false,
    });
    const result = await ext.extract(TINY_IMAGE);
    expect(result.fields.brand_name.value).toBe("Frontier Lager");
  });

  it("strips a prose preamble before the first '{' (open-weight quirk)", async () => {
    const noisy = "Sure, here's the JSON you asked for:\n\n" + JSON.stringify(FIELDS) + "\n\nHope that helps!";
    openrouterCreate.mockResolvedValueOnce(openrouterOk(noisy));
    const ext = new OpenRouterExtractor({
      apiKey: "or-test-key",
      modelSlug: "meta-llama/llama-3.2-90b-vision-instruct",
      pricing: { inputPer1M: 0.4, outputPer1M: 0.4 },
      structuredOutput: false,
    });
    const result = await ext.extract(TINY_IMAGE);
    expect(result.fields.brand_name.value).toBe("Frontier Lager");
  });

  it("throws a helpful error when the model returns non-JSON", async () => {
    openrouterCreate.mockResolvedValueOnce(openrouterOk("not json at all"));
    const ext = new OpenRouterExtractor({
      apiKey: "or-test-key",
      modelSlug: "openai/gpt-oss-120b",
      pricing: { inputPer1M: 0.3, outputPer1M: 0.5 },
      structuredOutput: false,
    });
    await expect(ext.extract(TINY_IMAGE)).rejects.toThrow(
      /response was not JSON/,
    );
  });

  it("throws when the parsed JSON fails the zod schema", async () => {
    const broken = { brand_name: { value: "x" /* missing confidence */ } };
    openrouterCreate.mockResolvedValueOnce(
      openrouterOk(JSON.stringify(broken)),
    );
    const ext = new OpenRouterExtractor({
      apiKey: "or-test-key",
      modelSlug: "openai/gpt-oss-120b",
      pricing: { inputPer1M: 0.3, outputPer1M: 0.5 },
      structuredOutput: false,
    });
    await expect(ext.extract(TINY_IMAGE)).rejects.toThrow(
      /schema validation failed/,
    );
  });
});

// ─── AbortSignal ────────────────────────────────────────────────────────────

describe("OpenRouterExtractor — AbortSignal", () => {
  it("rejects with AbortError when signal is pre-aborted", async () => {
    openrouterCreate.mockImplementation(() => new Promise(() => {}));
    const ext = new OpenRouterExtractor({
      apiKey: "or-test-key",
      modelSlug: "openai/gpt-5",
      pricing: { inputPer1M: 5, outputPer1M: 20 },
      structuredOutput: true,
    });
    const ctrl = new AbortController();
    ctrl.abort();
    await expect(
      ext.extract(TINY_IMAGE, { signal: ctrl.signal }),
    ).rejects.toMatchObject({ name: "AbortError" });
  });
});

// ─── OCR context ────────────────────────────────────────────────────────────

describe("OpenRouterExtractor — OCR context", () => {
  it("includes OCR text in the prompt when provided", async () => {
    openrouterCreate.mockResolvedValueOnce(
      openrouterOk(JSON.stringify(FIELDS)),
    );
    const ext = new OpenRouterExtractor({
      apiKey: "or-test-key",
      modelSlug: "openai/gpt-5",
      pricing: { inputPer1M: 5, outputPer1M: 20 },
      structuredOutput: true,
    });
    await ext.extract(TINY_IMAGE, { ocrText: "HINT TEXT FROM OCR" });

    const callArg = openrouterCreate.mock.calls[0]?.[0];
    const textPart = callArg.messages[0].content.find(
      (p: { type: string }) => p.type === "text",
    );
    expect(textPart.text).toContain("HINT TEXT FROM OCR");
  });
});
