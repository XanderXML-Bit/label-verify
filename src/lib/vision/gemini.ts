import { GoogleGenerativeAI, SchemaType } from "@google/generative-ai";
import {
  ExtractedFieldsSchema,
  type Extractor,
  type ExtractorContext,
  type ExtractorResult,
} from "./types";
import { EXTRACTION_PROMPT, getPromptHash } from "./prompt";

// ─── Gemini structured-output schema ────────────────────────────────────────
//
// Google's Generative-AI SDK uses its own SchemaType enum (a JSON-schema
// subset). We translate the Zod schema below by hand once; if the Zod
// schema drifts, this object also needs updating — caught by the prompt
// hash (different schemaShape → different hash → benchmark CI fails).

const RESPONSE_SCHEMA = {
  type: SchemaType.OBJECT,
  properties: {
    brand_name: fieldWithConfidence({ type: SchemaType.STRING }),
    class_type: fieldWithConfidence({ type: SchemaType.STRING }),
    abv_percent: fieldWithConfidence({ type: SchemaType.NUMBER }),
    net_contents: fieldWithConfidence({
      type: SchemaType.OBJECT,
      properties: {
        value: { type: SchemaType.NUMBER },
        unit: {
          type: SchemaType.STRING,
          enum: ["fl_oz", "ml", "L", "cl"],
        },
      },
      required: ["value", "unit"],
    }),
    government_warning: fieldWithConfidence({
      type: SchemaType.OBJECT,
      properties: {
        raw_text: { type: SchemaType.STRING, nullable: true },
        prefix_text: { type: SchemaType.STRING, nullable: true },
        prefix_bbox: {
          type: SchemaType.OBJECT,
          nullable: true,
          properties: {
            x: { type: SchemaType.NUMBER },
            y: { type: SchemaType.NUMBER },
            width: { type: SchemaType.NUMBER },
            height: { type: SchemaType.NUMBER },
          },
          required: ["x", "y", "width", "height"],
        },
        prefix_appears_bold: { type: SchemaType.BOOLEAN, nullable: true },
        prefix_appears_caps: { type: SchemaType.BOOLEAN, nullable: true },
      },
      required: [
        "raw_text",
        "prefix_text",
        "prefix_bbox",
        "prefix_appears_bold",
        "prefix_appears_caps",
      ],
    }),
    producer: fieldWithConfidence({
      type: SchemaType.OBJECT,
      properties: {
        name: { type: SchemaType.STRING, nullable: true },
        street: { type: SchemaType.STRING, nullable: true },
        city: { type: SchemaType.STRING, nullable: true },
        state: { type: SchemaType.STRING, nullable: true },
        postal_code: { type: SchemaType.STRING, nullable: true },
        country: { type: SchemaType.STRING, nullable: true },
      },
      required: ["name", "street", "city", "state", "postal_code", "country"],
    }),
    country_of_origin: fieldWithConfidence({ type: SchemaType.STRING }),
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
};

// eslint-disable-next-line @typescript-eslint/no-explicit-any
function fieldWithConfidence(inner: any) {
  return {
    type: SchemaType.OBJECT,
    properties: {
      value: { ...inner, nullable: true },
      confidence: { type: SchemaType.NUMBER },
    },
    required: ["value", "confidence"],
  };
}

// ─── Gemini Flash extractor (T6 — gemini-3.1-flash-lite by default) ─────────
//
// Probe results (scripts/probe-gemini.ts, 2026-05-12):
//   gemini-3.1-flash-lite          ✓ available
//   gemini-3.1-flash-lite-preview  ✓ available
//   gemini-3.1-flash               ✗ 404 (only -preview, no GA name)
// `gemini-2.0-flash-001` was decommissioned for new users early-2026 and
// has been replaced. We default to 3.1-flash-lite for the "fast tier"
// because it (a) responds, (b) is current per the user's directive, and
// (c) has measured P50 ≈ 2 s on test-data-v2.

const MODEL_DEFAULT = "gemini-3.1-flash-lite";

// Pricing per Google's published table (refresh if the SDK changes):
// Flash tier (2.0 + 2.5 flash): $0.075 / 1M input, $0.300 / 1M output.
// Pro tier (2.5-pro, <200K ctx): $1.25 / 1M input, $5.00 / 1M output.
const FLASH_PRICE_INPUT_PER_M = 0.075;
const FLASH_PRICE_OUTPUT_PER_M = 0.3;
const PRO_PRICE_INPUT_PER_M = 1.25;
const PRO_PRICE_OUTPUT_PER_M = 5.0;

// ─── Internal: shared Gemini call body ──────────────────────────────────────
//
// The Flash, Flash-Full, and Pro adapters differ only in default model and
// price coefficients. The request shape, schema, prompt, abort race, and
// response parsing are identical, so we share them via this helper rather
// than copy-pasting three near-identical classes.

interface GeminiCallOptions {
  genAI: GoogleGenerativeAI;
  modelVersion: string;
  priceInputPerM: number;
  priceOutputPerM: number;
  errorTag: string; // class name used as prefix in thrown errors
}

async function callGemini(
  image: Buffer,
  ctx: ExtractorContext | undefined,
  cfg: GeminiCallOptions,
  modelId: string,
): Promise<ExtractorResult> {
  const start = performance.now();

  const model = cfg.genAI.getGenerativeModel({
    model: cfg.modelVersion,
    generationConfig: {
      responseMimeType: "application/json",
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      responseSchema: RESPONSE_SCHEMA as any,
      temperature: 0.0,
    },
  });

  // OCR-conditionally-off-path: if OCR returned in time, we append its
  // text to the prompt so the vision model can cross-reference. If not,
  // the prompt goes without and the C1 combined path degenerates to T6.
  const ocrSection = ctx?.ocrText
    ? `\n\nFor reference, an OCR pass returned the following text. Use it as a hint, but do NOT trust it for the Government Warning verbatim text — re-read that from the image directly. OCR text:\n\n${ctx.ocrText}`
    : "";

  const promptText = EXTRACTION_PROMPT + ocrSection;

  const signal = ctx?.signal;
  const result = await Promise.race([
    model.generateContent({
      contents: [
        {
          role: "user",
          parts: [
            { text: promptText },
            {
              inlineData: {
                mimeType: "image/jpeg",
                data: image.toString("base64"),
              },
            },
          ],
        },
      ],
    }),
    abortPromise(signal),
  ]);

  const text = result.response.text();
  const usage = result.response.usageMetadata;

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
  const inputTokens = usage?.promptTokenCount ?? 0;
  const outputTokens = usage?.candidatesTokenCount ?? 0;

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

export class GeminiFlashExtractor implements Extractor {
  readonly id: string;
  readonly networkRequired = true;
  readonly modelVersion: string;
  private readonly genAI: GoogleGenerativeAI;

  constructor(opts: { apiKey: string; modelVersion?: string }) {
    if (!opts.apiKey) throw new Error("GeminiFlashExtractor: missing apiKey");
    this.modelVersion = opts.modelVersion ?? MODEL_DEFAULT;
    this.id = `gemini:${this.modelVersion}`;
    this.genAI = new GoogleGenerativeAI(opts.apiKey);
  }

  async extract(
    image: Buffer,
    ctx?: ExtractorContext,
  ): Promise<ExtractorResult> {
    return callGemini(
      image,
      ctx,
      {
        genAI: this.genAI,
        modelVersion: this.modelVersion,
        priceInputPerM: FLASH_PRICE_INPUT_PER_M,
        priceOutputPerM: FLASH_PRICE_OUTPUT_PER_M,
        errorTag: "GeminiFlashExtractor",
      },
      this.id,
    );
  }
}

// ─── Gemini 2.5 Flash (full, not lite) — T6b ────────────────────────────────
//
// Same Flash pricing tier as T6; the differentiator is the larger 2.5
// generation, which historically improves multilingual and OCR-on-image
// performance versus the 2.0 line. Same SDK, same schema, same prompt.

// Probe results (scripts/probe-gemini.ts, 2026-05-12): gemini-3.1-flash
// (no "-preview") returns 404 against the generativelanguage API. The
// flash-lite variant DOES respond. We pin to the 2.5 generation for the
// "full Flash" tier until Google removes the preview gate on 3.1-flash.
const FLASH_FULL_MODEL_DEFAULT = "gemini-2.5-flash";

export class GeminiFlashFullExtractor implements Extractor {
  readonly id: string;
  readonly networkRequired = true;
  readonly modelVersion: string;
  private readonly genAI: GoogleGenerativeAI;

  constructor(opts: { apiKey: string; modelVersion?: string }) {
    if (!opts.apiKey)
      throw new Error("GeminiFlashFullExtractor: missing apiKey");
    this.modelVersion = opts.modelVersion ?? FLASH_FULL_MODEL_DEFAULT;
    this.id = `gemini:${this.modelVersion}`;
    this.genAI = new GoogleGenerativeAI(opts.apiKey);
  }

  async extract(
    image: Buffer,
    ctx?: ExtractorContext,
  ): Promise<ExtractorResult> {
    return callGemini(
      image,
      ctx,
      {
        genAI: this.genAI,
        modelVersion: this.modelVersion,
        priceInputPerM: FLASH_PRICE_INPUT_PER_M,
        priceOutputPerM: FLASH_PRICE_OUTPUT_PER_M,
        errorTag: "GeminiFlashFullExtractor",
      },
      this.id,
    );
  }
}

// ─── Gemini 2.5 Pro — T6c ───────────────────────────────────────────────────
//
// Strongest Gemini tier as of the knowledge cutoff. The 200K-context price
// band applies for our single-image payloads (well under that threshold);
// long-context billing would need a separate adapter if we ever batched
// many images per request.

// Probe results (scripts/probe-gemini.ts, 2026-05-12): gemini-3.1-pro
// returns 404; gemini-3.1-pro-preview works. We default to the 3.1
// preview because the user explicitly wants frontier; 2.5-pro stays
// available via the MODEL_GEMINI_PRO env var override if anyone wants
// to A/B against the older generation.
const PRO_MODEL_DEFAULT = "gemini-3.1-pro-preview";

export class GeminiProExtractor implements Extractor {
  readonly id: string;
  readonly networkRequired = true;
  readonly modelVersion: string;
  private readonly genAI: GoogleGenerativeAI;

  constructor(opts: { apiKey: string; modelVersion?: string }) {
    if (!opts.apiKey) throw new Error("GeminiProExtractor: missing apiKey");
    this.modelVersion = opts.modelVersion ?? PRO_MODEL_DEFAULT;
    this.id = `gemini:${this.modelVersion}`;
    this.genAI = new GoogleGenerativeAI(opts.apiKey);
  }

  async extract(
    image: Buffer,
    ctx?: ExtractorContext,
  ): Promise<ExtractorResult> {
    return callGemini(
      image,
      ctx,
      {
        genAI: this.genAI,
        modelVersion: this.modelVersion,
        priceInputPerM: PRO_PRICE_INPUT_PER_M,
        priceOutputPerM: PRO_PRICE_OUTPUT_PER_M,
        errorTag: "GeminiProExtractor",
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
