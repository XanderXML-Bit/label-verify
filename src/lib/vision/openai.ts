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

// ─── GPT-4o-mini extractor ──────────────────────────────────────────────────

const MODEL_DEFAULT = "gpt-4o-mini-2024-07-18";

// Pricing per OpenAI's published table (as of the pinned model release):
// gpt-4o-mini: $0.150 / 1M input, $0.600 / 1M output.
const PRICE_INPUT_PER_M = 0.15;
const PRICE_OUTPUT_PER_M = 0.6;

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

    const response = await Promise.race([
      this.client.chat.completions.create(
        {
          model: this.modelVersion,
          temperature: 0,
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
        },
        signal ? { signal } : {},
      ),
      abortPromise(signal),
    ]);

    const choice = response.choices[0];
    const text = choice?.message.content ?? "";
    if (!text) {
      throw new Error("GPT4oMiniExtractor: empty response from model");
    }

    let parsedJson: unknown;
    try {
      parsedJson = JSON.parse(text);
    } catch (err) {
      throw new Error(
        `GPT4oMiniExtractor: response was not JSON: ${(err as Error).message}\n` +
          `Raw response (first 500 chars): ${text.slice(0, 500)}`,
      );
    }

    const parsed = ExtractedFieldsSchema.safeParse(parsedJson);
    if (!parsed.success) {
      throw new Error(
        `GPT4oMiniExtractor: schema validation failed: ${parsed.error.message}`,
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
          (inputTokens / 1_000_000) * PRICE_INPUT_PER_M +
          (outputTokens / 1_000_000) * PRICE_OUTPUT_PER_M,
      },
    };
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
