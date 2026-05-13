// Multi-run aggregator for the cross-pair bench.
//
// Why this module exists: a single bench draw is a sample from a noisy
// distribution. The vision model is non-deterministic, the REVIEW
// threshold sits on a confidence boundary that varies between runs,
// and per-image latency depends on Vercel cold-start state. A single
// run is not a reliable measurement of the verifier's quality — it's
// one sample of a multi-sample experiment.
//
// To make scientifically defensible claims about a code change, the
// protocol (see `docs/BENCH-PROTOCOL.md`) is:
//   1. Run the bench N≥3 times on the unchanged baseline.
//   2. Compute mean ± SD for each metric.
//   3. Apply the proposed change.
//   4. Run the bench N≥3 times again.
//   5. Compare deltas to the BASELINE noise band. If
//      |mean_new - mean_baseline| < 2·SD_baseline, the effect is
//      within noise — claim NO conclusion. Only declare improvement
//      when the effect is robustly larger than noise (and the same
//      logic catches regressions before they ship).
//
// This module exposes the two helpers that turn raw run JSON into a
// noise band + per-image consistency table. Pure functions; no I/O.

/**
 * Subset of the bench bucket taxonomy that this module cares about.
 * Mirrors `src/lib/bench-classify.ts` but kept local-only so the
 * aggregator can be tested without the full bucket types in scope.
 */
export type Bucket =
  | "true-pass"
  | "false-fail"
  | "review-on-correct"
  | "true-fail"
  | "false-pass-on-correct"
  | "error-on-correct"
  | "true-reject"
  | "false-pass-on-wrong"
  | "review-on-wrong"
  | "error-on-wrong";

export interface RunRecord {
  image: string;
  condition: "correct" | "wrong";
  bucket: Bucket;
}

export interface RunSummary {
  passRateOnCorrect: number;
  failOrReviewRateOnWrong: number;
  errors: number;
  latencyMs: {
    p50_total: number;
    p95_total: number;
    p50_vision: number;
    p95_vision: number;
  };
}

export interface RunInput {
  summary: RunSummary;
  records: readonly RunRecord[];
}

export interface MetricBand {
  n: number;
  mean: number;
  sd: number;
  min: number;
  max: number;
}

export interface AggregateResult {
  passRateOnCorrect: MetricBand;
  failOrReviewRateOnWrong: MetricBand;
  errors: MetricBand;
  p50_total: MetricBand;
  p95_total: MetricBand;
  p50_vision: MetricBand;
  p95_vision: MetricBand;
}

/**
 * Aggregate N runs into a mean ± (sample) SD band for each headline
 * metric. SD uses the (N-1) divisor — the classic unbiased estimator
 * for a population standard deviation given a sample. When N=1 we
 * report sd=0 (statistically undefined; we surface 0 so consumers
 * don't have to special-case the display, and the `n` field makes
 * the under-sampling obvious).
 */
export function aggregateRuns(runs: readonly RunInput[]): AggregateResult {
  if (runs.length === 0) {
    throw new Error("aggregateRuns requires at least one run");
  }
  const pluck = (f: (r: RunInput) => number): MetricBand => band(runs.map(f));
  return {
    passRateOnCorrect: pluck((r) => r.summary.passRateOnCorrect),
    failOrReviewRateOnWrong: pluck((r) => r.summary.failOrReviewRateOnWrong),
    errors: pluck((r) => r.summary.errors),
    p50_total: pluck((r) => r.summary.latencyMs.p50_total),
    p95_total: pluck((r) => r.summary.latencyMs.p95_total),
    p50_vision: pluck((r) => r.summary.latencyMs.p50_vision),
    p95_vision: pluck((r) => r.summary.latencyMs.p95_vision),
  };
}

function band(values: number[]): MetricBand {
  const n = values.length;
  const mean = values.reduce((a, b) => a + b, 0) / n;
  let sd = 0;
  if (n > 1) {
    const sumSquaredDev = values.reduce(
      (acc, v) => acc + (v - mean) * (v - mean),
      0,
    );
    sd = Math.sqrt(sumSquaredDev / (n - 1));
  }
  return {
    n,
    mean,
    sd,
    min: Math.min(...values),
    max: Math.max(...values),
  };
}

/**
 * Per-image consistency classification. Categorises every (image,
 * condition) pair observed across N runs into one of five labels:
 *
 *  - `DETERMINISTIC_PASS`: every run reported a passing bucket
 *    (`true-pass`, `true-fail`, or `true-reject`). The verifier is
 *    reliably correct on this image. No work needed.
 *  - `DETERMINISTIC_FAIL`: every run reported the SAME failing
 *    bucket (e.g. `false-fail` × N). The verifier is reliably
 *    wrong on this image — this is a real, reproducible bug
 *    worth investigating.
 *  - `DETERMINISTIC_ERROR`: every run crashed on this image with
 *    an error bucket. Usually a GT / schema / perturbation defect.
 *  - `INCONSISTENT_NON_PASS`: the verifier never PASSED this
 *    image, but the failure bucket varied across runs (e.g.
 *    `false-fail` in run 1, `review-on-correct` in run 2). Still
 *    a real concern but the failure mode itself is unstable.
 *  - `FLIPPER`: the verifier sometimes passed and sometimes
 *    failed this image. Per scientific protocol, individual
 *    flippers MUST NOT be treated as bugs — they're samples from
 *    a noisy verifier and the right tool is sample-size, not
 *    bug-fixing.
 *
 * The `bucketCounts` field surfaces the raw distribution so a human
 * reviewer can decide for themselves; the `classification` is just
 * the helper's recommendation.
 */
export type Classification =
  | "DETERMINISTIC_PASS"
  | "DETERMINISTIC_FAIL"
  | "DETERMINISTIC_ERROR"
  | "INCONSISTENT_NON_PASS"
  | "FLIPPER";

export interface ImageRow {
  image: string;
  condition: "correct" | "wrong";
  timesObserved: number;
  bucketCounts: Partial<Record<Bucket, number>>;
  classification: Classification;
}

/**
 * Walk every record across N runs, group by (image, condition),
 * tally the bucket distribution, and apply the consistency
 * classification rules above.
 */
export function perImageConsistency(
  runs: readonly RunInput[],
): ImageRow[] {
  if (runs.length === 0) return [];
  type Key = string;
  const rows = new Map<
    Key,
    {
      image: string;
      condition: "correct" | "wrong";
      buckets: Map<Bucket, number>;
    }
  >();
  for (const run of runs) {
    for (const rec of run.records) {
      const key: Key = `${rec.image}::${rec.condition}`;
      const slot =
        rows.get(key) ??
        { image: rec.image, condition: rec.condition, buckets: new Map() };
      slot.buckets.set(
        rec.bucket,
        (slot.buckets.get(rec.bucket) ?? 0) + 1,
      );
      rows.set(key, slot);
    }
  }
  const out: ImageRow[] = [];
  for (const slot of rows.values()) {
    const counts: Partial<Record<Bucket, number>> = {};
    let total = 0;
    for (const [b, c] of slot.buckets) {
      counts[b] = c;
      total += c;
    }
    out.push({
      image: slot.image,
      condition: slot.condition,
      timesObserved: total,
      bucketCounts: counts,
      classification: classify(counts),
    });
  }
  return out;
}

const PASS_BUCKETS = new Set<Bucket>(["true-pass", "true-fail", "true-reject"]);
const ERROR_BUCKETS = new Set<Bucket>(["error-on-correct", "error-on-wrong"]);

function classify(
  counts: Partial<Record<Bucket, number>>,
): Classification {
  const entries = Object.entries(counts) as Array<[Bucket, number]>;
  const passCount = entries
    .filter(([b]) => PASS_BUCKETS.has(b))
    .reduce((a, [, c]) => a + c, 0);
  const errorCount = entries
    .filter(([b]) => ERROR_BUCKETS.has(b))
    .reduce((a, [, c]) => a + c, 0);
  const failCount = entries
    .filter(([b]) => !PASS_BUCKETS.has(b) && !ERROR_BUCKETS.has(b))
    .reduce((a, [, c]) => a + c, 0);
  const total = passCount + failCount + errorCount;

  // Pure error every run — almost always a GT / schema defect, NOT
  // a verifier bug. Caller can investigate the error message.
  if (errorCount === total) return "DETERMINISTIC_ERROR";

  // Every run reported a passing bucket — the verifier is right.
  if (passCount === total) return "DETERMINISTIC_PASS";

  // Mixed pass + fail = flipper. The verifier is fundamentally
  // non-deterministic on this image; sample size is the right tool.
  if (passCount > 0 && failCount > 0) return "FLIPPER";

  // No passes at all. If only one failing bucket showed up, it's
  // deterministic; otherwise the failure mode itself is unstable.
  const failingBuckets = entries.filter(
    ([b, c]) => !PASS_BUCKETS.has(b) && !ERROR_BUCKETS.has(b) && c > 0,
  );
  if (failingBuckets.length === 1) return "DETERMINISTIC_FAIL";
  return "INCONSISTENT_NON_PASS";
}
