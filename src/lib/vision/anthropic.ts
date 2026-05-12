import Anthropic from "@anthropic-ai/sdk";
import {
  ExtractedFieldsSchema,
  type Extractor,
  type ExtractorContext,
  type ExtractorResult,
} from "./types";
import { EXTRACTION_PROMPT, getPromptHash } from "./prompt";

// ─── Claude Sonnet extractor ────────────────────────────────────────────────
//
// Unlike Gemini and OpenAI, the Anthropic Messages API does not have a
// native JSON-schema response mode. We compensate by:
//   1. Repeating the shape requirement in a prompt suffix.
//   2. Parsing the first text block as JSON manually.
//   3. Validating against ExtractedFieldsSchema with zod's safeParse.
//
// If Anthropic ships a native structured-output mode later, swap (1)+(2)
// for the SDK call; (3) stays as the source of truth.

const MODEL_DEFAULT = "claude-sonnet-4-6";

// Pricing per Anthropic's published table for Sonnet 4.6:
// $3 / 1M input tokens, $15 / 1M output tokens.
const PRICE_INPUT_PER_M = 3;
const PRICE_OUTPUT_PER_M = 15;

// Max tokens for the structured response. The extracted-fields object
// fits comfortably in ~600 tokens; 2048 gives headroom for long Government
// Warnings on novelty labels without runaway.
const MAX_OUTPUT_TOKENS = 2048;

const JSON_ONLY_SUFFIX = `

Your response MUST be a single JSON object matching the schema described
above. Output ONLY the JSON object — no prose before or after, no code
fences, no commentary. The first character of your response must be "{"
and the last character must be "}".`;

export class ClaudeSonnetExtractor implements Extractor {
  readonly id: string;
  readonly networkRequired = true;
  readonly modelVersion: string;
  private readonly client: Anthropic;

  constructor(opts: { apiKey: string; modelVersion?: string }) {
    if (!opts.apiKey) throw new Error("ClaudeSonnetExtractor: missing apiKey");
    this.modelVersion = opts.modelVersion ?? MODEL_DEFAULT;
    this.id = `anthropic:${this.modelVersion}`;
    this.client = new Anthropic({ apiKey: opts.apiKey });
  }

  async extract(
    image: Buffer,
    ctx?: ExtractorContext,
  ): Promise<ExtractorResult> {
    const start = performance.now();

    // OCR-conditionally-off-path treatment, same as Gemini / OpenAI.
    const ocrSection = ctx?.ocrText
      ? `\n\nFor reference, an OCR pass returned the following text. Use it as a hint, but do NOT trust it for the Government Warning verbatim text — re-read that from the image directly. OCR text:\n\n${ctx.ocrText}`
      : "";
    const promptText = EXTRACTION_PROMPT + ocrSection + JSON_ONLY_SUFFIX;

    const signal = ctx?.signal;

    const response = await Promise.race([
      this.client.messages.create(
        {
          model: this.modelVersion,
          max_tokens: MAX_OUTPUT_TOKENS,
          temperature: 0,
          messages: [
            {
              role: "user",
              content: [
                {
                  type: "image",
                  source: {
                    type: "base64",
                    media_type: "image/jpeg",
                    data: image.toString("base64"),
                  },
                },
                { type: "text", text: promptText },
              ],
            },
          ],
        },
        signal ? { signal } : {},
      ),
      abortPromise(signal),
    ]);

    // Find the first text block. Anthropic responses are arrays of typed
    // content blocks; for our prompt we expect exactly one text block.
    const textBlock = response.content.find((b) => b.type === "text");
    if (!textBlock || textBlock.type !== "text") {
      throw new Error(
        "ClaudeSonnetExtractor: no text block in response content",
      );
    }
    const text = textBlock.text;

    let parsedJson: unknown;
    try {
      parsedJson = JSON.parse(text);
    } catch (err) {
      throw new Error(
        `ClaudeSonnetExtractor: response was not JSON: ${(err as Error).message}\n` +
          `Raw response (first 500 chars): ${text.slice(0, 500)}`,
      );
    }

    const parsed = ExtractedFieldsSchema.safeParse(parsedJson);
    if (!parsed.success) {
      throw new Error(
        `ClaudeSonnetExtractor: schema validation failed: ${parsed.error.message}`,
      );
    }

    const latencyMs = performance.now() - start;
    const inputTokens = response.usage.input_tokens;
    const outputTokens = response.usage.output_tokens;

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
