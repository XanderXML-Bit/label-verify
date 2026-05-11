// Statistical scoring for the benchmark harness.
//
// Per TEST-STRATEGY.md §7a: every accuracy number is reported with a
// Wilson 95% CI; technique-vs-technique comparisons are tested via
// McNemar's test; results are stratified by (beverage × condition ×
// field) and the OOD real-label set is reported separately.

export interface PerItemOutcome {
  /** Stable ID for the label, e.g. "syn-beer-0042". */
  imageId: string;
  /** Field name being scored. */
  field: string;
  /** Was the extractor right on this (image, field) pair? */
  correct: boolean;
  /** Stratification axes, free-form labels (e.g. "beer", "low-light"). */
  strata: Record<string, string>;
  /** True if this item is in the out-of-distribution real-label set. */
  ood?: boolean;
}

// ─── Wilson 95% CI ──────────────────────────────────────────────────────────

/**
 * Wilson score interval for a binomial proportion. Returns [lo, hi].
 * Preferred over normal-approximation CI because it stays inside [0,1]
 * and works near the boundaries.
 */
export function wilson95(successes: number, total: number): [number, number] {
  if (total === 0) return [0, 1];
  const z = 1.959964; // 95% two-sided
  const p = successes / total;
  const denom = 1 + (z * z) / total;
  const center = (p + (z * z) / (2 * total)) / denom;
  const halfWidth =
    (z * Math.sqrt((p * (1 - p)) / total + (z * z) / (4 * total * total))) / denom;
  return [Math.max(0, center - halfWidth), Math.min(1, center + halfWidth)];
}

export interface AccuracyPoint {
  /** Point estimate (correct / total). */
  acc: number;
  ciLo: number;
  ciHi: number;
  n: number;
}

export function summarize(outcomes: PerItemOutcome[]): AccuracyPoint {
  const n = outcomes.length;
  const k = outcomes.filter((o) => o.correct).length;
  const [lo, hi] = wilson95(k, n);
  return { acc: n === 0 ? 0 : k / n, ciLo: lo, ciHi: hi, n };
}

// ─── McNemar's test (paired technique vs technique) ─────────────────────────

/**
 * McNemar's chi-squared (with continuity correction) on a 2×2 table:
 *
 *                technique B
 *                correct   wrong
 *   technique A  correct    a       b
 *                wrong      c       d
 *
 * Tests H0: the two techniques have equal accuracy on the same set of
 * items. Returns { statistic, pValue, b, c } where b and c are the
 * discordant counts. p-value uses the chi-squared 1-df CDF approximation.
 *
 * Use case: deciding whether C1 (combined) actually beats T6 (Gemini Flash
 * alone) on the same corpus, not just got luckier.
 */
export function mcNemar(
  outcomesA: PerItemOutcome[],
  outcomesB: PerItemOutcome[],
): { statistic: number; pValue: number; b: number; c: number } {
  // Index by imageId+field so order doesn't matter.
  const key = (o: PerItemOutcome) => `${o.imageId}|${o.field}`;
  const mapA = new Map(outcomesA.map((o) => [key(o), o]));
  let b = 0; // A correct, B wrong
  let c = 0; // A wrong, B correct
  for (const ob of outcomesB) {
    const oa = mapA.get(key(ob));
    if (!oa) continue;
    if (oa.correct && !ob.correct) b++;
    else if (!oa.correct && ob.correct) c++;
  }
  if (b + c === 0) {
    return { statistic: 0, pValue: 1, b, c };
  }
  // Continuity correction:  (|b-c| - 1)^2 / (b+c)
  const stat = Math.pow(Math.abs(b - c) - 1, 2) / (b + c);
  const p = chiSquared1dfSurvival(stat);
  return { statistic: stat, pValue: p, b, c };
}

/** Survival function for chi-sq with 1 df: 1 - F(x) = erfc(sqrt(x/2)) */
function chiSquared1dfSurvival(x: number): number {
  if (x <= 0) return 1;
  return erfc(Math.sqrt(x / 2));
}

// Abramowitz–Stegun complementary error function approximation.
function erfc(x: number): number {
  if (x < 0) return 2 - erfc(-x);
  const t = 1 / (1 + 0.3275911 * x);
  const y =
    1 -
    (((((1.061405429 * t - 1.453152027) * t) + 1.421413741) * t -
      0.284496736) *
      t +
      0.254829592) *
      t *
      Math.exp(-x * x);
  return 1 - y;
}

// ─── Stratified aggregation ─────────────────────────────────────────────────

export interface StratifiedTable {
  /** Stratum descriptor — e.g. { beverage: "beer", condition: "low-light", field: "abv_percent" } */
  strata: Record<string, string>;
  acc: AccuracyPoint;
}

/**
 * Group outcomes by every distinct combination of strata keys (plus
 * field), summarize each group. Skip groups with n=0.
 */
export function stratify(
  outcomes: PerItemOutcome[],
  keys: string[],
): StratifiedTable[] {
  const groups = new Map<string, PerItemOutcome[]>();
  for (const o of outcomes) {
    const composite = JSON.stringify([
      ...keys.map((k) => o.strata[k] ?? "?"),
      o.field,
    ]);
    if (!groups.has(composite)) groups.set(composite, []);
    groups.get(composite)!.push(o);
  }
  const out: StratifiedTable[] = [];
  for (const [comp, items] of groups.entries()) {
    const parts = JSON.parse(comp) as string[];
    const strata: Record<string, string> = {};
    keys.forEach((k, i) => {
      strata[k] = parts[i] ?? "?";
    });
    strata.field = parts[parts.length - 1] ?? "?";
    out.push({ strata, acc: summarize(items) });
  }
  return out;
}

// ─── False-negative rate (regulator-dangerous direction on Gov Warning) ─────

export interface PerItemWarningOutcome {
  imageId: string;
  /** Truth: is this label actually compliant? */
  truthCompliant: boolean;
  /** Prediction: did the validator say PASS? */
  predictedPass: boolean;
  strata: Record<string, string>;
  ood?: boolean;
}

/**
 * False-negative rate on the Government Warning = P(predictedPass=true
 * AND truthCompliant=false). "Passing a non-compliant label" — the
 * direction a regulator cares about most.
 */
export function falseNegativeRate(outcomes: PerItemWarningOutcome[]): AccuracyPoint {
  const noncompliant = outcomes.filter((o) => !o.truthCompliant);
  const escaped = noncompliant.filter((o) => o.predictedPass).length;
  const total = noncompliant.length;
  if (total === 0) return { acc: 0, ciLo: 0, ciHi: 0, n: 0 };
  const [lo, hi] = wilson95(escaped, total);
  return { acc: escaped / total, ciLo: lo, ciHi: hi, n: total };
}

// ─── OOD partitioning ───────────────────────────────────────────────────────

export function partitionOod(
  outcomes: PerItemOutcome[],
): { id: PerItemOutcome[]; ood: PerItemOutcome[] } {
  const id: PerItemOutcome[] = [];
  const ood: PerItemOutcome[] = [];
  for (const o of outcomes) (o.ood ? ood : id).push(o);
  return { id, ood };
}
