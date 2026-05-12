import OpenAI from "openai";
import {
  ExtractedFieldsSchema,
  type Extractor,
  type ExtractorContext,
  type ExtractorResult,
} from "./types";
import { EXTRACTION_PROMPT, getPromptHash } from "./prompt";

// ─── OpenRouter extractor ───────────────────────────────────────────────────
//
// OpenRouter (https://openrouter.ai) proxies dozens of providers (OpenAI,
// Google, Anthropic, Meta, Mistral, NVIDIA, xAI, open-weight hosts, …)
// behind an OpenAI-compatible REST API. By pointing the `openai` SDK at
// `https://openrouter.ai/api/v1` we unlock the long tail of frontier models
// — including ones whose direct SDKs lag behind (Gemini 3.x preview lines,
// GPT-5 family, GPT-OSS-120B, Pixtral, Llama 3.x Vision, Nemotron, …) —
// without adding a dependency or duplicating the request plumbing.
//
// Design notes:
//   1. We accept `pricing` per-call from the caller because OpenRouter's
//      per-model rates differ by model and change more often than the
//      app's release cycle. Hard-coding them at the technique factory keeps
//      cost reporting honest without polling the registry at runtime.
//   2. JSON-schema "structured outputs" support varies by upstream model:
//      Gemini-via-OpenRouter and GPT-* respect `response_format.json_schema`
//      with `strict: true`. Open-weight models (GPT-OSS, Llama, Pixtral,
//      some Nemotron lines) often DON'T — they ignore the schema field and
//      return prose. For those we fall back to a "JSON-only" instruction
//      suffix and rely on zod's safeParse to validate. Callers select
//      between the two via the `structuredOutput` constructor flag.
//   3. The `modelSlug` is OpenRouter's `provider/model-name` identifier
//      (e.g. `openai/gpt-5`, `google/gemini-3-flash-lite-preview`).
//   4. modelId is `openrouter:<modelSlug>` so the bench reports keep the
//      provider path visible — useful when comparing the same model via
//      direct SDK vs OpenRouter (latency, structured-output behaviour).

type JsonSchemaObject = Record<string, unknown>;

function fieldWithConfidence(inner: JsonSchemaObject): JsonSchemaObject {
  // The "value" can be null when the field isn't present on the label.
  // Strict-mode upstream providers (OpenAI-family) demand the null-union
  // be expressed in `type`. Gemini-via-OpenRouter accepts the same form.
  const nullableInner = addNullToType(inner);
  return {
    type: "object",
    properties: {
      value: nullableInner,
      confidence: { type: "number" },
    },
    required: ["value", "confidence"],
    additionalProperties: false,
  };
}

function addNullToType(node: JsonSchemaObject): JsonSchemaObject {
  const t = node["type"];
  if (Array.isArray(t)) {
    return t.includes("null") ? { ...node } : { ...node, type: [...t, "null"] };
  }
  if (typeof t === "string") {
    return { ...node, type: [t, "null"] };
  }
  return { ...node };
}

const RESPONSE_SCHEMA: JsonSchemaObject = {
  type: "object",
  properties: {
    brand_name: fieldWithConfidence({ type: "string" }),
    class_type: fieldWithConfidence({ type: "string" }),
    abv_percent: fieldWithConfidence({ type: "number" }),
    net_contents: fieldWithConfidence({
      type: "object",
      properties: {
        value: { type: "number" },
        unit: { type: "string", enum: ["fl_oz", "ml", "L", "cl"] },
      },
      required: ["value", "unit"],
      additionalProperties: false,
    }),
    government_warning: fieldWithConfidence({
      type: "object",
      properties: {
        raw_text: { type: ["string", "null"] },
        prefix_text: { type: ["string", "null"] },
        prefix_bbox: {
          type: ["object", "null"],
          properties: {
            x: { type: "number" },
            y: { type: "number" },
            width: { type: "number" },
            height: { type: "number" },
          },
          required: ["x", "y", "width", "height"],
          additionalProperties: false,
        },
        prefix_appears_bold: { type: ["boolean", "null"] },
        prefix_appears_caps: { type: ["boolean", "null"] },
      },
      required: [
        "raw_text",
        "prefix_text",
        "prefix_bbox",
        "prefix_appears_bold",
        "prefix_appears_caps",
      ],
      additionalProperties: false,
    }),
    producer: fieldWithConfidence({
      type: "object",
      properties: {
        name: { type: ["string", "null"] },
        street: { type: ["string", "null"] },
        city: { type: ["string", "null"] },
        state: { type: ["string", "null"] },
        postal_code: { type: ["string", "null"] },
        country: { type: ["string", "null"] },
      },
      required: ["name", "street", "city", "state", "postal_code", "country"],
      additionalProperties: false,
    }),
    country_of_origin: fieldWithConfidence({ type: "string" }),
  },
  required: [
    "brand_name",
    "class_type",
    "abv_percent",
    "net_contents",
    "government_warning",
    "producer",
    "country_of_origin",
  ],
  additionalProperties: false,
};

const JSON_ONLY_SUFFIX = `

Your response MUST be a single JSON object matching the schema described
above. Output ONLY the JSON object — no prose before or after, no code
fences, no commentary. The first character of your response must be "{"
and the last character must be "}".`;

const OPENROUTER_BASE_URL = "https://openrouter.ai/api/v1";

export interface OpenRouterPricing {
  /** Price per 1,000,000 input tokens, USD. */
  inputPer1M: number;
  /** Price per 1,000,000 output tokens, USD. */
  outputPer1M: number;
}

export interface OpenRouterExtractorOptions {
  apiKey: string;
  /** Provider-prefixed model slug, e.g. "google/gemini-3-pro-preview". */
  modelSlug: string;
  /** Per-token pricing supplied by the caller. */
  pricing: OpenRouterPricing;
  /**
   * Pinned model version. Defaults to `modelSlug`. Useful when OpenRouter
   * exposes versioned aliases (e.g. `google/gemini-3-pro-preview` vs the
   * pinned `…-2026-01` snapshot) and we want the bench log to record the
   * exact pin used.
   */
  modelVersion?: string;
  /**
   * Whether the upstream model supports OpenAI-style JSON-schema strict
   * mode. Set true for the Gemini and GPT families via OpenRouter; set
   * false for most open-weight models (GPT-OSS, Llama-Vision, Pixtral)
   * which silently ignore the schema field. Defaults to false (safer:
   * worst case we get prose + a JSON-parse error, not a 400).
   */
  structuredOutput?: boolean;
  /**
   * Optional HTTP-Referer + X-Title headers that OpenRouter uses for its
   * leaderboards. Harmless to omit; we leave it off by default to avoid
   * leaking install URLs into a third-party dashboard.
   */
  appReferer?: string;
  appTitle?: string;
}

export class OpenRouterExtractor implements Extractor {
  readonly id: string;
  readonly networkRequired = true;
  readonly modelSlug: string;
  readonly modelVersion: string;
  private readonly client: OpenAI;
  private readonly pricing: OpenRouterPricing;
  private readonly structuredOutput: boolean;

  constructor(opts: OpenRouterExtractorOptions) {
    if (!opts.apiKey) throw new Error("OpenRouterExtractor: missing apiKey");
    if (!opts.modelSlug)
      throw new Error("OpenRouterExtractor: missing modelSlug");
    this.modelSlug = opts.modelSlug;
    this.modelVersion = opts.modelVersion ?? opts.modelSlug;
    this.id = `openrouter:${this.modelSlug}`;
    this.pricing = opts.pricing;
    this.structuredOutput = opts.structuredOutput ?? false;

    const defaultHeaders: Record<string, string> = {};
    if (opts.appReferer) defaultHeaders["HTTP-Referer"] = opts.appReferer;
    if (opts.appTitle) defaultHeaders["X-Title"] = opts.appTitle;

    this.client = new OpenAI({
      apiKey: opts.apiKey,
      baseURL: OPENROUTER_BASE_URL,
      defaultHeaders:
        Object.keys(defaultHeaders).length > 0 ? defaultHeaders : undefined,
    });
  }

  async extract(
    image: Buffer,
    ctx?: ExtractorContext,
  ): Promise<ExtractorResult> {
    const start = performance.now();

    // OCR-conditionally-off-path treatment, identical to the direct adapters.
    const ocrSection = ctx?.ocrText
      ? `\n\nFor reference, an OCR pass returned the following text. Use it as a hint, but do NOT trust it for the Government Warning verbatim text — re-read that from the image directly. OCR text:\n\n${ctx.ocrText}`
      : "";

    // When the upstream model doesn't honour json_schema we lean on the
    // explicit instruction suffix to nudge it into emitting bare JSON.
    const promptText =
      EXTRACTION_PROMPT +
      ocrSection +
      (this.structuredOutput ? "" : JSON_ONLY_SUFFIX);

    const signal = ctx?.signal;
    const imageDataUrl = `data:image/jpeg;base64,${image.toString("base64")}`;

    // Build the request. When structuredOutput is on we attach
    // response_format.json_schema like the OpenAI adapter; when it's off
    // we fall back to plain chat completion and parse manually. `stream:
    // false` is pinned so the SDK's overload picks the non-streaming
    // return type (we need `.choices` synchronously below).
    const responseFormat = this.structuredOutput
      ? ({
          type: "json_schema",
          json_schema: {
            name: "extracted_label_fields",
            strict: true,
            schema: RESPONSE_SCHEMA,
          },
        } as const)
      : undefined;

    const response = await Promise.race([
      this.client.chat.completions.create(
        {
          model: this.modelSlug,
          temperature: 0,
          stream: false,
          ...(responseFormat ? { response_format: responseFormat } : {}),
          messages: [
            {
              role: "user",
              content: [
                { type: "text", text: promptText },
                {
                  type: "image_url",
                  image_url: { url: imageDataUrl, detail: "high" },
                },
              ],
            },
          ],
        },
        signal ? { signal } : {},
      ),
      abortPromise(signal),
    ]);

    const choice = response.choices[0];
    const text = choice?.message.content ?? "";
    if (!text) {
      throw new Error(
        `OpenRouterExtractor[${this.modelSlug}]: empty response from model`,
      );
    }

    // Manual parse path. Even when strict json_schema is requested the
    // upstream model occasionally wraps output in ```json fences (Gemini)
    // or leading prose (Pixtral, Llama). Strip both before parsing so a
    // single stray character doesn't fail the whole call.
    const cleaned = stripJsonWrappers(text);

    let parsedJson: unknown;
    try {
      parsedJson = JSON.parse(cleaned);
    } catch (err) {
      throw new Error(
        `OpenRouterExtractor[${this.modelSlug}]: response was not JSON: ${(err as Error).message}\n` +
          `Raw response (first 500 chars): ${text.slice(0, 500)}`,
      );
    }

    const parsed = ExtractedFieldsSchema.safeParse(parsedJson);
    if (!parsed.success) {
      throw new Error(
        `OpenRouterExtractor[${this.modelSlug}]: schema validation failed: ${parsed.error.message}`,
      );
    }

    const latencyMs = performance.now() - start;
    const inputTokens = response.usage?.prompt_tokens ?? 0;
    const outputTokens = response.usage?.completion_tokens ?? 0;

    return {
      fields: parsed.data,
      rawOutput: parsedJson,
      latencyMs,
      modelId: this.id,
      modelVersion: this.modelVersion,
      promptHash: getPromptHash(),
      cost: {
        inputTokens,
        outputTokens,
        costUsd:
          (inputTokens / 1_000_000) * this.pricing.inputPer1M +
          (outputTokens / 1_000_000) * this.pricing.outputPer1M,
      },
    };
  }
}

// ─── helpers ────────────────────────────────────────────────────────────────

/**
 * Strip the most common wrappers around model JSON output — code fences,
 * a leading "```json" tag, a trailing "```", or a short prose preamble
 * before the first "{". Conservative: if no clear JSON object boundary
 * is found we return the original string so the parse error message
 * stays informative.
 */
function stripJsonWrappers(text: string): string {
  let s = text.trim();
  // Code fence: ```json ... ``` or ``` ... ```
  if (s.startsWith("```")) {
    const fenceEnd = s.indexOf("\n");
    if (fenceEnd > 0) s = s.slice(fenceEnd + 1);
    if (s.endsWith("```")) s = s.slice(0, -3);
    s = s.trim();
  }
  // Prose preamble before the first "{".
  const firstBrace = s.indexOf("{");
  const lastBrace = s.lastIndexOf("}");
  if (firstBrace > 0 && lastBrace > firstBrace) {
    s = s.slice(firstBrace, lastBrace + 1);
  }
  return s;
}

function abortPromise(signal: AbortSignal | undefined): Promise<never> {
  if (!signal) return new Promise(() => {}); // pending forever
  if (signal.aborted) {
    return Promise.reject(new DOMException("aborted", "AbortError"));
  }
  return new Promise((_, reject) => {
    signal.addEventListener(
      "abort",
      () => reject(new DOMException("aborted", "AbortError")),
      { once: true },
    );
  });
}
