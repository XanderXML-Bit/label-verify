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

// ─── Gemini Flash extractor ─────────────────────────────────────────────────

const MODEL_DEFAULT = "gemini-2.0-flash-001";

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
    const start = performance.now();

    const model = this.genAI.getGenerativeModel({
      model: this.modelVersion,
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
        `GeminiFlashExtractor: response was not JSON: ${(err as Error).message}\n` +
          `Raw response (first 500 chars): ${text.slice(0, 500)}`,
      );
    }

    const parsed = ExtractedFieldsSchema.safeParse(parsedJson);
    if (!parsed.success) {
      throw new Error(
        `GeminiFlashExtractor: schema validation failed: ${parsed.error.message}`,
      );
    }

    const latencyMs = performance.now() - start;
    const inputTokens = usage?.promptTokenCount ?? 0;
    const outputTokens = usage?.candidatesTokenCount ?? 0;

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
        // Pricing as of model release: Flash $0.075 / 1M input,
        // $0.30 / 1M output. Refresh if the SDK changes.
        costUsd:
          (inputTokens / 1_000_000) * 0.075 +
          (outputTokens / 1_000_000) * 0.3,
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
