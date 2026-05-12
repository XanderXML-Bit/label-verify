import type {
  ExtractedFields,
  Extractor,
  ExtractorContext,
  ExtractorResult,
} from "./types";

// ─── Tiered escalation extractor (C5 from APPROACH.md §2.3) ─────────────────
//
// Always runs the fast tier first. If the minimum per-field confidence is
// below `confidenceThreshold`, runs the strong tier and returns its result
// instead — but reports the SUM of latencies so the benchmark harness sees
// the true wall-clock cost of the escalation. Escalation metadata is
// surfaced in `rawOutput` so the harness can count escalation rate without
// changing the Extractor interface.

interface TieredOpts {
  fast: Extractor;
  strong: Extractor;
  /** Minimum acceptable per-field confidence on the fast result. Default 0.65. */
  confidenceThreshold?: number;
}

const DEFAULT_THRESHOLD = 0.65;

interface EscalationRawOutput {
  escalated: true;
  fastConfidence: number;
  fastResult: ExtractorResult;
  strongResult: unknown;
}

export class TieredEscalationExtractor implements Extractor {
  readonly id: string;
  readonly networkRequired: boolean;
  private readonly fast: Extractor;
  private readonly strong: Extractor;
  private readonly threshold: number;

  constructor(opts: TieredOpts) {
    this.fast = opts.fast;
    this.strong = opts.strong;
    this.threshold = opts.confidenceThreshold ?? DEFAULT_THRESHOLD;
    this.id = `tiered:${this.fast.id}->${this.strong.id}@${this.threshold}`;
    this.networkRequired = this.fast.networkRequired || this.strong.networkRequired;
  }

  async extract(
    image: Buffer,
    ctx?: ExtractorContext,
  ): Promise<ExtractorResult> {
    throwIfAborted(ctx?.signal);

    const fastResult = await this.fast.extract(image, ctx);

    throwIfAborted(ctx?.signal);

    const minConf = minConfidence(fastResult.fields);
    if (minConf >= this.threshold) {
      // Fast tier was confident enough — return as-is.
      return fastResult;
    }

    // Escalate. The strong tier sees the same context (so OCR text is
    // forwarded), and we surface the escalation in rawOutput.
    const strongResult = await this.strong.extract(image, ctx);

    throwIfAborted(ctx?.signal);

    const rawOutput: EscalationRawOutput = {
      escalated: true,
      fastConfidence: minConf,
      fastResult,
      strongResult: strongResult.rawOutput,
    };

    return {
      fields: strongResult.fields,
      rawOutput,
      // True wall-clock cost: fast + strong. The harness should bill us
      // for both, not pretend the fast call never happened.
      latencyMs: fastResult.latencyMs + strongResult.latencyMs,
      modelId: this.id,
      modelVersion: strongResult.modelVersion,
      promptHash: strongResult.promptHash,
      cost: {
        inputTokens: fastResult.cost.inputTokens + strongResult.cost.inputTokens,
        outputTokens:
          fastResult.cost.outputTokens + strongResult.cost.outputTokens,
        costUsd: fastResult.cost.costUsd + strongResult.cost.costUsd,
      },
    };
  }
}

// Minimum self-reported confidence across all fields. We use the minimum
// (not the mean) because a single 0.1-confidence field is a stronger
// signal that the model is guessing than a uniform 0.7 across the board.
function minConfidence(fields: ExtractedFields): number {
  return Math.min(
    fields.brand_name.confidence,
    fields.class_type.confidence,
    fields.abv_percent.confidence,
    fields.net_contents.confidence,
    fields.government_warning.confidence,
    fields.producer.confidence,
    fields.country_of_origin.confidence,
  );
}

function throwIfAborted(signal: AbortSignal | undefined): void {
  if (signal?.aborted) {
    throw new DOMException("aborted", "AbortError");
  }
}
