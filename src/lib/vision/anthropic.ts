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

// ─── Internal: shared Anthropic messages call ───────────────────────────────
//
// Sonnet (T5) and Haiku (T5b) differ only in default model and price tier.
// The Messages API call shape, manual JSON parse, and abort race are
// identical, so we share them here.

interface AnthropicCallOptions {
  client: Anthropic;
  modelVersion: string;
  priceInputPerM: number;
  priceOutputPerM: number;
  errorTag: string;
}

async function callAnthropic(
  image: Buffer,
  ctx: ExtractorContext | undefined,
  cfg: AnthropicCallOptions,
  modelId: string,
): Promise<ExtractorResult> {
  const start = performance.now();

  // OCR-conditionally-off-path treatment, same as Gemini / OpenAI.
  const ocrSection = ctx?.ocrText
    ? `\n\nFor reference, an OCR pass returned the following text. Use it as a hint, but do NOT trust it for the Government Warning verbatim text — re-read that from the image directly. OCR text:\n\n${ctx.ocrText}`
    : "";
  const promptText = EXTRACTION_PROMPT + ocrSection + JSON_ONLY_SUFFIX;

  const signal = ctx?.signal;

  const response = await Promise.race([
    cfg.client.messages.create(
      {
        model: cfg.modelVersion,
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
    throw new Error(`${cfg.errorTag}: no text block in response content`);
  }
  const text = textBlock.text;

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
  const inputTokens = response.usage.input_tokens;
  const outputTokens = response.usage.output_tokens;

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
    return callAnthropic(
      image,
      ctx,
      {
        client: this.client,
        modelVersion: this.modelVersion,
        priceInputPerM: PRICE_INPUT_PER_M,
        priceOutputPerM: PRICE_OUTPUT_PER_M,
        errorTag: "ClaudeSonnetExtractor",
      },
      this.id,
    );
  }
}

// ─── Claude Haiku extractor (T5b) ───────────────────────────────────────────
//
// Anthropic's fast tier. Cheaper and faster than Sonnet, with a distinct
// accuracy/latency profile worth measuring against the Gemini/OpenAI
// fast-tier candidates. Same Messages API call path as Sonnet — only the
// default model and prices change.

const HAIKU_MODEL_DEFAULT = "claude-haiku-4-5";
const HAIKU_PRICE_INPUT_PER_M = 1;
const HAIKU_PRICE_OUTPUT_PER_M = 5;

export class ClaudeHaikuExtractor implements Extractor {
  readonly id: string;
  readonly networkRequired = true;
  readonly modelVersion: string;
  private readonly client: Anthropic;

  constructor(opts: { apiKey: string; modelVersion?: string }) {
    if (!opts.apiKey) throw new Error("ClaudeHaikuExtractor: missing apiKey");
    this.modelVersion = opts.modelVersion ?? HAIKU_MODEL_DEFAULT;
    this.id = `anthropic:${this.modelVersion}`;
    this.client = new Anthropic({ apiKey: opts.apiKey });
  }

  async extract(
    image: Buffer,
    ctx?: ExtractorContext,
  ): Promise<ExtractorResult> {
    return callAnthropic(
      image,
      ctx,
      {
        client: this.client,
        modelVersion: this.modelVersion,
        priceInputPerM: HAIKU_PRICE_INPUT_PER_M,
        priceOutputPerM: HAIKU_PRICE_OUTPUT_PER_M,
        errorTag: "ClaudeHaikuExtractor",
      },
      this.id,
    );
  }
}

// ─── Claude Opus extractor (T12 — frontier 1M-context tier) ─────────────────
//
// Anthropic's frontier tier. Heavier and slower than Sonnet but with the
// 1M-context window available for long-document follow-up work; on a
// single beverage-label image the context window is moot, so what we're
// really measuring here is whether Opus's reasoning advantage actually
// translates into verbatim-text-recall and bbox-localisation accuracy
// worth the ~5x Sonnet cost. Same Messages API call path as Sonnet —
// only the default model and prices change.

// Latest Anthropic frontier vision tier on the direct SDK as of 2026-05.
// OpenRouter exposes the same model as `anthropic/claude-opus-4.7` (dot,
// not dash) at the SAME price; T12's factory keeps both code paths.
const OPUS_MODEL_DEFAULT = "claude-opus-4-7";
// Pricing per Anthropic's published Opus 4.7 table (re-tiered down from
// the 4.0/4.1 era pricing): $5 / 1M input, $25 / 1M output.
const OPUS_PRICE_INPUT_PER_M = 5;
const OPUS_PRICE_OUTPUT_PER_M = 25;

export class ClaudeOpusExtractor implements Extractor {
  readonly id: string;
  readonly networkRequired = true;
  readonly modelVersion: string;
  private readonly client: Anthropic;

  constructor(opts: { apiKey: string; modelVersion?: string }) {
    if (!opts.apiKey) throw new Error("ClaudeOpusExtractor: missing apiKey");
    this.modelVersion = opts.modelVersion ?? OPUS_MODEL_DEFAULT;
    this.id = `anthropic:${this.modelVersion}`;
    this.client = new Anthropic({ apiKey: opts.apiKey });
  }

  async extract(
    image: Buffer,
    ctx?: ExtractorContext,
  ): Promise<ExtractorResult> {
    return callAnthropic(
      image,
      ctx,
      {
        client: this.client,
        modelVersion: this.modelVersion,
        priceInputPerM: OPUS_PRICE_INPUT_PER_M,
        priceOutputPerM: OPUS_PRICE_OUTPUT_PER_M,
        errorTag: "ClaudeOpusExtractor",
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
