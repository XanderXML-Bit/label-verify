// Cross-pair bench classification — pure projection of the
// (condition, expected, actual) triple into a 9-bucket taxonomy.
//
// Why this module exists: the raw bench records carry the three
// inputs but not the derived "what kind of correct / what kind of
// wrong" tag. A reviewer trying to investigate "where are our
// false-positives?" should not have to mentally combine three
// fields per row across 340 rows — the bucket field does the
// projection once at record time so every downstream consumer
// (summary, per-image Markdown, dashboards) reads the same value.
//
// The taxonomy is strict and full-coverage — every (condition,
// expected, actual) triple maps to exactly one bucket. New
// verdict / condition values would be a TypeScript type error,
// not a silent miss.

/**
 * Condition column — which ground truth the verifier ran against.
 *  - `correct`: the original GT we shipped (or the one our auditor
 *    confirmed). Expected verdict comes from the GW booleans in the
 *    GT (PASS if all four are true; FAIL otherwise).
 *  - `wrong`: a perturbed GT (declared brand changed, ABV swapped,
 *    etc.) deliberately mismatched against the label. Expected
 *    verdict is always `fail` because at least one field is wrong
 *    by construction.
 */
export type Condition = "correct" | "wrong";

/** The verifier's output verdict, plus `error` for crashes / 5xx. */
export type Verdict = "pass" | "fail" | "review" | "error";

export type Bucket =
  /* correct side */
  | "true-pass" //          condition=correct  expected=pass  actual=pass
  | "false-fail" //         condition=correct  expected=pass  actual=fail  (operator-cost FN)
  | "review-on-correct" //  condition=correct  expected=*     actual=review
  | "true-fail" //          condition=correct  expected=fail  actual=fail
  | "false-pass-on-correct"// condition=correct expected=fail actual=pass  (rare; GT says fail but we passed)
  | "error-on-correct" //   condition=correct  actual=error
  /* wrong side */
  | "true-reject" //        condition=wrong    expected=fail  actual=fail
  | "false-pass-on-wrong" //condition=wrong    expected=fail  actual=pass  (regulator-dangerous FP)
  | "review-on-wrong" //    condition=wrong    expected=fail  actual=review (REVIEW deferral safety net)
  | "error-on-wrong"; //    condition=wrong    actual=error

/**
 * Iteration order matters: errors first (highest-priority for
 * operator review), then false-positives (regulator-dangerous),
 * then false-fails (operator-cost), then reviews, then the
 * happy-path buckets last. The per-image Markdown writer walks
 * this order so the most-actionable findings surface at the top.
 */
export const BUCKETS: readonly Bucket[] = [
  "error-on-correct",
  "error-on-wrong",
  "false-pass-on-wrong",
  "false-pass-on-correct",
  "false-fail",
  "review-on-correct",
  "review-on-wrong",
  "true-pass",
  "true-fail",
] as const;
// Note: `true-reject` is intentionally last via separate const
// (the happy-path correct-rejection bucket — usually the largest
// bucket on a healthy run, so it gets the summary-table treatment
// rather than per-image listing). See BUCKETS_FULL below.
export const BUCKETS_FULL: readonly Bucket[] = [...BUCKETS, "true-reject"] as const;

export function classifyBucket(input: {
  condition: Condition;
  expected: Verdict;
  actual: Verdict;
}): Bucket {
  const { condition, expected, actual } = input;
  if (actual === "error") {
    return condition === "correct" ? "error-on-correct" : "error-on-wrong";
  }
  if (condition === "correct") {
    if (actual === "review") return "review-on-correct";
    if (expected === "pass") {
      return actual === "pass" ? "true-pass" : "false-fail";
    }
    // expected === "fail" on the correct side — rare (only when GT
    // gov_warning compliance booleans say the label is non-compliant)
    // but legal.
    return actual === "fail" ? "true-fail" : "false-pass-on-correct";
  }
  // condition === "wrong" — expected is always "fail" by construction.
  if (actual === "review") return "review-on-wrong";
  return actual === "fail" ? "true-reject" : "false-pass-on-wrong";
}

const LABELS: Record<Bucket, string> = {
  "true-pass": "true pass (correct verdict on a compliant label)",
  "false-fail": "false fail / false negative (compliant label rejected)",
  "review-on-correct":
    "review on correct GT (needs human eyeballs; not a defect, but friction)",
  "true-fail":
    "true fail (correct verdict on a non-compliant correct GT label)",
  "false-pass-on-correct":
    "false pass on correct GT (rare; correct GT said fail but verifier said pass)",
  "error-on-correct": "error on correct GT (verifier crashed / no verdict)",
  "true-reject":
    "true reject (correct verdict — perturbed wrong GT caught and rejected)",
  "false-pass-on-wrong":
    "false positive (perturbed wrong GT slipped through as PASS — regulator-dangerous)",
  "review-on-wrong":
    "review on wrong GT (REVIEW deferral safety net caught it instead of FAIL — not strictly correct but not dangerous)",
  "error-on-wrong": "error on wrong GT (verifier crashed / no verdict)",
};

export function bucketLabel(b: Bucket): string {
  return LABELS[b];
}
