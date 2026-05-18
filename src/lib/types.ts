import { z } from "zod";
import {
  NetContentsSchema,
  ProducerAddressSchema,
  type ExtractedFields,
} from "./vision/types";
import type { FieldComparison } from "./matching";
import type { GovernmentWarningCheck } from "./validation/government-warning";

// ─── DeclaredFields ────────────────────────────────────────────────────────
//
// What the COLA applicant said on their application form. This is the
// "expected" side of every comparison; the extractor returns the "actual."

export const DeclaredFieldsSchema = z.object({
  brand_name: z.string().min(1),
  class_type: z.string().min(1),
  /** Class category, used for ABV tolerance lookup. */
  class_category: z.enum([
    "beer",
    "wine",
    "distilled_spirits",
    "fortified_wine",
  ]),
  abv_percent: z.number().min(0).max(100),
  net_contents: NetContentsSchema,
  /**
   * Producer / importer. The applicant may submit a single freeform line
   * (legacy) or a structured object (preferred). The validator accepts
   * either and normalizes internally.
   *
   * Nullish (wave-34 audit fix #13): the GUI used to submit an empty
   * string when the producer field was blank, which downstream
   * compared empty-vs-empty and silently PASSED — masking the case
   * where the applicant genuinely forgot to fill it (a TTB-required
   * field per 27 CFR §4.32 / §5.32). Accepting null / undefined here
   * lets the form submit "not declared" honestly, and the comparator
   * routes to REVIEW so a human confirms before approval.
   */
  producer: z.union([ProducerAddressSchema, z.string()]).nullish(),
  /**
   * Country of origin. Nullish (accepts null and undefined) because
   * TTB only requires country marking on imports (27 CFR §4.39 /
   * §5.36); a US-domestic application may legitimately omit it.
   * Both inline-manifest rows that strip null values and explicit
   * `null` fields in user-authored JSON manifests reach the
   * downstream comparator as null. When null, the comparator
   * PASSes if the label is also missing a country marking and the
   * producer address looks US-domestic, and REVIEWs otherwise.
   */
  country_of_origin: z.string().min(2).nullish(),
});
export type DeclaredFields = z.infer<typeof DeclaredFieldsSchema>;

// ─── VerifyRequest ──────────────────────────────────────────────────────────

export const VerifyRequestSchema = z.object({
  declared: DeclaredFieldsSchema,
});
export type VerifyRequest = z.infer<typeof VerifyRequestSchema>;

// ─── VerifyResponse ─────────────────────────────────────────────────────────

export type Verdict = "pass" | "fail" | "review";
export type ImageQuality = "good" | "low" | "bad";

export interface VerifyTimings {
  preprocess: number;
  ocr: number | null;
  vision: number;
  matching: number;
  total: number;
}

export interface VerifyResponse {
  /** Aggregate compliance verdict — independent of image quality. */
  verdict: Verdict;
  /** Aggregate image quality assessment — independent of compliance. */
  imageQuality: ImageQuality;
  /** Reason the image is low/bad (e.g. "low confidence on multiple fields"). */
  imageQualityReason?: string;
  /** Per-field results. */
  fields: {
    brand_name: FieldComparison;
    class_type: FieldComparison;
    abv_percent: FieldComparison;
    net_contents: FieldComparison;
    producer: FieldComparison;
    country_of_origin: FieldComparison;
  };
  governmentWarning: GovernmentWarningCheck;
  /** What the extractor saw, in case the user wants to dig in. */
  extracted: ExtractedFields;
  timings: VerifyTimings;
  /** Free-text note from the verifier; surfaced only on debug or REVIEW. */
  note?: string;
  /** Model that produced the extraction; surfaced only in /api/debug/last. */
  modelId: string;
  modelVersion: string;
  /**
   * Approximate per-call USD cost — sourced from the server-side
   * `src/lib/vision/cost.ts` lookup keyed on `modelId`. Optional
   * because (a) older cached responses or test stubs may omit it,
   * (b) unknown model ids legitimately return `null` and we serialise
   * that as undefined. The UI degrades gracefully when absent.
   *
   * Added wave-35 Track 1 #2 so the cost table lives in exactly one
   * place (the server). Previously the client had its own copy that
   * drifted whenever the model rotation shifted.
   */
  costUsd?: number;
  /** Stable internal marker for the single production verification path. */
  modeUsed: "default" | string;
  /**
   * True iff the aggregate verdict is `"review"`. Drives the human-review
   * queue: the API route enqueues the response when this is true.
   *
   * NOTE: this is intentionally redundant with `verdict === "review"`. The
   * boolean exists so downstream callers (logging, dashboards, batch CSVs)
   * can branch on a single field without re-implementing the rule.
   */
  requiresHumanReview: boolean;
  /**
   * Human-readable reasons we routed this to review. Empty when
   * `requiresHumanReview` is false. Each entry is one sentence; the UI
   * concatenates them into a bullet list.
   */
  reviewReasons: string[];
  /**
   * Set when the primary vision provider was unreachable and the
   * orchestrator fell back to a different model (e.g. GPT-5.4-nano).
   * The UI renders a yellow "verified via backup model" banner when
   * this is present. Omitted on normal primary-path verifications.
   */
  fallbackUsed?: string;
  /**
   * Set when the orchestrator fired an independent second-opinion
   * vision call on a borderline Government Warning (primary returned
   * REVIEW, or primary returned PASS at low confidence without OCR
   * corroboration). The second-opinion model defaults to Gemini 2.5
   * Flash since wave-22 (same provider as the primary Flash-Lite —
   * the bake-off found same-provider was the best Pareto under
   * the current operator constraints); operator can route to OpenAI
   * via `SECOND_OPINION_PROVIDER=openai`. The actual model that ran
   * is recorded in `secondOpinion.modelId`. Surfaced in the UI
   * under the GW subscore panel. Omitted on confident-PASS /
   * clear-FAIL verifications.
   */
  secondOpinion?: SecondOpinion;
}

export interface SecondOpinion {
  /** Model id that produced the second-opinion extraction. */
  modelId: string;
  /** The second extractor's independent Gov-Warning verdict. */
  governmentWarning: GovernmentWarningCheck;
  /**
   * True iff the second-opinion Gov-Warning STATUS matches the primary's.
   * (Confidence may differ; we only compare the verdict bucket.)
   * `false` means the two extractors disagree — surface the disagreement
   * to the reviewer so they adjudicate.
   */
  agreesWithPrimary: boolean;
  /** Human-readable trigger reason (why the second opinion fired). */
  reason: string;
  /** Wall-clock latency of the second-opinion call (ms). */
  latencyMs: number;
}

// ─── Review queue types ─────────────────────────────────────────────────────
//
// Re-exported from review-queue.ts so consumers can grab the queue shape
// from the same module that defines VerifyResponse. The runtime definitions
// live in review-queue.ts to keep this file pure type declarations.
export type {
  ReviewQueueItem,
  ReviewResolution,
} from "./review-queue";

// ─── VerifyTrace ────────────────────────────────────────────────────────────
//
// Re-exported from lib/debug-trace.ts so consumers can pull both the response
// shape and the trace shape from one place.
export type { VerifyTrace } from "./debug-trace";
