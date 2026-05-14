// Bench-record stratification.
//
// The pre-wave-28 cross-pair guardrail was a single corpus-wide budget:
// `false-pass-on-correct ≤ baseline + 2σ`. Wave-26's revert (size-
// threshold relaxation that gained +11.5 real-photo true-pass at the
// cost of +1 fp on a single synthetic adversarial S2 case) revealed
// that a single budget over-rejects: the marginal value of catching
// one designed-to-fool synthetic defect is not equivalent to the
// marginal value of accepting one real compliant photo.
//
// This module categorizes each (image, gov_warning_case) record into
// a stratum so a stratified guardrail can be applied: real-photo
// fp-on-correct must NOT increase (regulator-critical), while
// synthetic-adversarial fp-on-correct has a bounded budget.
//
// The corpus has four de-facto strata, identified by `gov_warning_case`
// in the GT files:
//
//   adversarial:  intentionally-crafted defect cases (B/S/T/C/X tags
//                 + the explicit "non-compliant-*" tags + "missing")
//   compliant:    real-photo C0, synthetic "compliant", and the
//                 untagged PASS cases (most of `null` gov_warning_case)
//   quality:      Q*-prefixed degradation cases (glare, blur, stain,
//                 rotation, occlusion) — these test image quality and
//                 the orchestrator's REVIEW routing, NOT compliance
//   unknown:      anything else (defensive fallback)

export type BenchStratum = "adversarial" | "compliant" | "quality" | "unknown";

/**
 * Categorize a bench record by its `gov_warning_case` GT tag.
 *
 * Resilient to the corpus's irregular casing + slash-combination tags
 * (e.g. "T1/B2" → adversarial because it contains either T or B).
 */
export function stratify(govWarningCase: string | null | undefined): BenchStratum {
  if (govWarningCase == null) {
    // Untagged records are the C0/PASS baseline by convention. Most
    // of the 170-image corpus's "no specific defect" rows have
    // `gov_warning_case: null` in their GT and are treated as
    // compliant real-photo baseline.
    return "compliant";
  }
  const tag = govWarningCase.trim();
  if (tag.length === 0) return "compliant";

  // Lowercase-literal escape hatches first, before the
  // uppercase-prefix dispatch — otherwise "compliant" matches the
  // C-prefix branch.
  const lower = tag.toLowerCase();
  if (lower === "compliant" || lower === "pass") return "compliant";
  if (lower === "missing" || lower.startsWith("non-compliant")) {
    return "adversarial";
  }

  const upper = tag.toUpperCase();

  // Adversarial: any tag whose first letter (or any slash-segment's
  // first letter) is one of B / S / T / X. Also catches the explicit
  // "N1_*" net-contents edge cases.
  if (
    upper.startsWith("B") ||
    upper.startsWith("S") ||
    upper.startsWith("T") ||
    upper.startsWith("X") ||
    upper.startsWith("N1_") ||
    upper.includes("/B") ||
    upper.includes("/S") ||
    upper.includes("/T") ||
    upper.includes("/X")
  ) {
    return "adversarial";
  }
  // C0 is the real-photo compliant baseline; everything else starting
  // with C is an adversarial caps defect (C1/C2/C3 + variants).
  if (upper.startsWith("C")) {
    return upper === "C0" ? "compliant" : "adversarial";
  }
  if (upper.startsWith("Q")) {
    return "quality";
  }
  return "unknown";
}

/**
 * Bucket-by-stratum count for a list of bench records.
 *
 * Returns counts per (stratum × bucket) so the stratified guardrail
 * can be applied:
 *   - adversarial.false-pass-on-correct  → bounded budget
 *   - compliant.false-pass-on-correct    → must NOT increase
 *                                          (regulator-critical)
 *   - quality.false-pass-on-correct      → bounded budget
 *   - compliant.false-fail               → must NOT increase
 */
export interface StratifiedCounts {
  /** Total records in this stratum (sanity check). */
  n: number;
  buckets: Record<string, number>;
}

interface RecordLike {
  govWarningCase?: string | null;
  condition: "correct" | "wrong";
  bucket?: string;
}

export function stratifiedCounts(
  records: RecordLike[],
): Record<BenchStratum, StratifiedCounts> {
  const out: Record<BenchStratum, StratifiedCounts> = {
    adversarial: { n: 0, buckets: {} },
    compliant: { n: 0, buckets: {} },
    quality: { n: 0, buckets: {} },
    unknown: { n: 0, buckets: {} },
  };
  for (const r of records) {
    const s = stratify(r.govWarningCase);
    out[s].n += 1;
    if (r.bucket) {
      out[s].buckets[r.bucket] = (out[s].buckets[r.bucket] || 0) + 1;
    }
  }
  return out;
}
