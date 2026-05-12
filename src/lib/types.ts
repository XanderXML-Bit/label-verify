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
   */
  producer: z.union([ProducerAddressSchema, z.string()]),
  country_of_origin: z.string().min(2),
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
