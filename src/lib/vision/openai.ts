import OpenAI from "openai";
import {
  ExtractedFieldsSchema,
  type Extractor,
  type ExtractorContext,
  type ExtractorResult,
} from "./types";
import { EXTRACTION_PROMPT, getPromptHash } from "./prompt";

// ─── OpenAI structured-output JSON Schema ───────────────────────────────────
//
// OpenAI's `response_format: { type: "json_schema", json_schema: { strict: true } }`
// is stricter than Gemini's responseSchema. The constraints that bit us when
// translating from the Gemini schema:
//
//   1. `additionalProperties: false` is REQUIRED on every object.
//   2. Every key listed in `properties` MUST appear in `required` — even
//      conceptually-optional ones. (Optionality is expressed by adding "null"
//      to the type union, NOT by omitting from `required`.)
//   3. `nullable: true` is NOT supported — use `type: ["string", "null"]`.
//
// We mirror the same semantic shape as the Gemini adapter and the Zod
// ExtractedFieldsSchema; the field set is identical, only the encoding
// differs. If the Zod schema drifts, the prompt hash (getPromptHash) will
// change and CI will catch the mismatch.

type JsonSchemaObject = Record<string, unknown>;

function fieldWithConfidence(inner: JsonSchemaObject): JsonSchemaObject {
  // The "value" can be null when the field isn't present on the label.
  // OpenAI strict mode demands the null-union be expressed in `type`.
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

// Add "null" to a JSON-schema node's `type`. Works for both scalar and
// object/array nodes. Mutates a copy, not the input.
function addNullToType(node: JsonSchemaObject): JsonSchemaObject {
  const t = node["type"];
  if (Array.isArray(t)) {
    return t.includes("null") ? { ...node } : { ...node, type: [...t, "null"] };
  }
  if (typeof t === "string") {
    return { ...node, type: [t, "null"] };
  }
  // No type set — leave as-is (shouldn't happen for our schema).
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

// ─── Internal: shared OpenAI chat-completions call ──────────────────────────
//
// GPT-4o-mini (T4) and GPT-4o-full (T4b) differ only in default model
// version and price coefficients. The request shape (strict JSON schema,
// vision image_url block, abort race, response parsing) is identical, so
// we share it here rather than duplicate it.

interface OpenAICallOptions {
  client: OpenAI;
  modelVersion: string;
  priceInputPerM: number;
  priceOutputPerM: number;
  errorTag: string;
}

async function callOpenAI(
  image: Buffer,
  ctx: ExtractorContext | undefined,
  cfg: OpenAICallOptions,
  modelId: string,
): Promise<ExtractorResult> {
  const start = performance.now();

  // Same OCR-conditionally-off-path treatment as Gemini: if OCR text was
  // ready in time we include it; otherwise the C1 combined path silently
  // degrades to T4.
  const ocrSection = ctx?.ocrText
    ? `\n\nFor reference, an OCR pass returned the following text. Use it as a hint, but do NOT trust it for the Government Warning verbatim text — re-read that from the image directly. OCR text:\n\n${ctx.ocrText}`
    : "";
  const promptText = EXTRACTION_PROMPT + ocrSection;

  const signal = ctx?.signal;
  const imageDataUrl = `data:image/jpeg;base64,${image.toString("base64")}`;

  // GPT-5 series (probed 2026-05-12) rejects `max_tokens` and requires
  // `max_completion_tokens` — and also rejects non-default `temperature`.
  // Detect by model-name prefix and switch params accordingly. GPT-4.x +
  // earlier accept both shapes.
  const isGpt5 = /^gpt-5(\b|[._-])/i.test(cfg.modelVersion);
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const createParams: any = {
    model: cfg.modelVersion,
    response_format: {
      type: "json_schema",
      json_schema: {
        name: "extracted_label_fields",
        strict: true,
        schema: RESPONSE_SCHEMA,
      },
    },
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
  };
  if (!isGpt5) {
    createParams.temperature = 0;
  }
  // For GPT-5 we don't set a token cap — the structured-output schema
  // bounds the response anyway, and the reasoning tier can need more
  // headroom. For GPT-4.x we leave defaults (no max_tokens) for the
  // same reason.

  const response = await Promise.race([
    cfg.client.chat.completions.create(
      createParams,
      signal ? { signal } : {},
    ),
    abortPromise(signal),
  ]);

  const choice = response.choices[0];
  const text = choice?.message.content ?? "";
  if (!text) {
    throw new Error(`${cfg.errorTag}: empty response from model`);
  }

  let parsedJson: unknown;
  try {
    parsedJson = JSON.parse(text);
  } catch (err) {
    throw new Error(
      `${cfg.errorTag}: response was not JSON: ${(err as Error).message}\n` +
        `Raw response (first 500 chars): ${text.slice(0, 500)}`,
    );
  }

  const parsed = ExtractedFieldsSchema.safeParse(parsedJson);
  if (!parsed.success) {
    throw new Error(
      `${cfg.errorTag}: schema validation failed: ${parsed.error.message}`,
    );
  }

  const latencyMs = performance.now() - start;
  const inputTokens = response.usage?.prompt_tokens ?? 0;
  const outputTokens = response.usage?.completion_tokens ?? 0;

  return {
    fields: parsed.data,
    rawOutput: parsedJson,
    latencyMs,
    modelId,
    modelVersion: cfg.modelVersion,
    promptHash: getPromptHash(),
    cost: {
      inputTokens,
      outputTokens,
      costUsd:
        (inputTokens / 1_000_000) * cfg.priceInputPerM +
        (outputTokens / 1_000_000) * cfg.priceOutputPerM,
    },
  };
}

// ─── GPT-4o-mini extractor (T4) ─────────────────────────────────────────────

// User directive (2026-05-12): default to current GPT-5 nano tier. The
// older gpt-4o-mini default remains available via MODEL_PRIMARY override
// for A/B comparison.
const MODEL_DEFAULT = "gpt-5-nano";

// Pricing for the default tier. Defaults are the published rates for
// `gpt-5-nano` as of the user's 2026-05-12 directive; if you override
// modelVersion to gpt-4o-mini (mini was $0.150 / $0.600 per 1M), bump
// the rates accordingly. Treat as approximate — bench harness records
// actual usage tokens; rates feed the USD-per-1k extrapolation only.
const PRICE_INPUT_PER_M = 0.05;
const PRICE_OUTPUT_PER_M = 0.4;

export class GPT4oMiniExtractor implements Extractor {
  readonly id: string;
  readonly networkRequired = true;
  readonly modelVersion: string;
  private readonly client: OpenAI;

  constructor(opts: { apiKey: string; modelVersion?: string }) {
    if (!opts.apiKey) throw new Error("GPT4oMiniExtractor: missing apiKey");
    this.modelVersion = opts.modelVersion ?? MODEL_DEFAULT;
    this.id = `openai:${this.modelVersion}`;
    this.client = new OpenAI({ apiKey: opts.apiKey });
  }

  async extract(
    image: Buffer,
    ctx?: ExtractorContext,
  ): Promise<ExtractorResult> {
    return callOpenAI(
      image,
      ctx,
      {
        client: this.client,
        modelVersion: this.modelVersion,
        priceInputPerM: PRICE_INPUT_PER_M,
        priceOutputPerM: PRICE_OUTPUT_PER_M,
        errorTag: "GPT4oMiniExtractor",
      },
      this.id,
    );
  }
}

// ─── GPT-4o (full) extractor (T4b) ──────────────────────────────────────────
//
// Full GPT-4o, not the mini variant. Pricing is ~17x mini on input and
// ~17x on output, so this is the "smartest, dearest" OpenAI candidate
// in the bake-off — the question is whether the accuracy gain is worth
// the cost multiplier on a small label image.

// User directive (2026-05-12): default the "full / dear / smartest"
// OpenAI tier to GPT-5. The older gpt-4o default stays accessible via
// the modelVersion option for direct A/B comparison.
const FULL_MODEL_DEFAULT = "gpt-5";
// User directive (2026-05-12): default rates for gpt-5 full. The older
// gpt-4o full was $2.50 / $10 per 1M — those are the rates if you
// override modelVersion. Refresh against the current OpenAI rate card
// before relying on the USD-per-1k bench column for a deploy decision.
const FULL_PRICE_INPUT_PER_M = 1.25;
const FULL_PRICE_OUTPUT_PER_M = 10;

export class GPT4oFullExtractor implements Extractor {
  readonly id: string;
  readonly networkRequired = true;
  readonly modelVersion: string;
  private readonly client: OpenAI;

  constructor(opts: { apiKey: string; modelVersion?: string }) {
    if (!opts.apiKey) throw new Error("GPT4oFullExtractor: missing apiKey");
    this.modelVersion = opts.modelVersion ?? FULL_MODEL_DEFAULT;
    this.id = `openai:${this.modelVersion}`;
    this.client = new OpenAI({ apiKey: opts.apiKey });
  }

  async extract(
    image: Buffer,
    ctx?: ExtractorContext,
  ): Promise<ExtractorResult> {
    return callOpenAI(
      image,
      ctx,
      {
        client: this.client,
        modelVersion: this.modelVersion,
        priceInputPerM: FULL_PRICE_INPUT_PER_M,
        priceOutputPerM: FULL_PRICE_OUTPUT_PER_M,
        errorTag: "GPT4oFullExtractor",
      },
      this.id,
    );
  }
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
