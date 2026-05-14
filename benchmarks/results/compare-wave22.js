// Wave-22 bench analysis: compare wave-22 runs against baseline N=8.
//
// Usage: node benchmarks/results/compare-wave22.js wave22-run1.json [wave22-run2.json ...]
//
// Output: per-bucket delta vs baseline mean ± 2σ, with explicit
// flag for the pre-registered acceptance criterion
// (false-pass-on-correct must NOT regress).

const fs = require("node:fs");
const path = require("node:path");

const baseline = JSON.parse(
  fs.readFileSync(path.join(__dirname, "baseline-N8-stats.json"), "utf8"),
);

const buckets = [
  "true-pass",
  "false-fail",
  "review-on-correct",
  "false-pass-on-correct",
  "true-fail",
  "error-on-correct",
  "true-reject",
  "review-on-wrong",
  "error-on-wrong",
];

function countBuckets(file) {
  const d = JSON.parse(fs.readFileSync(file, "utf8"));
  const c = {};
  for (const r of d.records || []) {
    c[r.bucket] = (c[r.bucket] || 0) + 1;
  }
  return { counts: c, summary: d.summary, file };
}

const inputs = process.argv.slice(2);
if (inputs.length === 0) {
  console.error("Usage: node compare-wave22.js <run.json> [run2.json ...]");
  process.exit(1);
}

const runs = inputs.map(countBuckets);

console.log("\n=== Wave-22 vs Baseline (N=8 gpt-5.4-nano second-opinion) ===\n");

console.log(`${"bucket".padEnd(25)} ${"base±2σ".padEnd(22)} ` +
  runs.map((r, i) => `run${i + 1}`.padEnd(8)).join("") + "verdict");
console.log("-".repeat(60 + runs.length * 8));

let regressedBuckets = [];
let improvedBuckets = [];

for (const bk of buckets) {
  const b = baseline.stats[bk];
  if (!b) continue;
  const lower = +(b.mean - 2 * b.sd).toFixed(1);
  const upper = +(b.mean + 2 * b.sd).toFixed(1);
  const baseStr = `${b.mean.toFixed(1)} ±${(2 * b.sd).toFixed(1)}`;

  const vals = runs.map((r) => r.counts[bk] || 0);
  // Verdict: is the mean of wave-22 runs within baseline ±2σ band?
  const w22Mean = vals.reduce((s, x) => s + x, 0) / vals.length;
  // Direction-of-improvement table:
  //   true-pass / true-reject / true-fail   → UP is good
  //   false-fail / false-pass-on-correct    → DOWN is good (regulator-critical)
  //   error-on-correct / error-on-wrong     → DOWN is good
  //   review-on-correct                     → DOWN is good (less friction)
  //   review-on-wrong                       → DOWN is good (sharper rejection
  //                                            iff true-reject went up by same)
  const goodIfUp = new Set(["true-pass", "true-reject", "true-fail"]);
  const goodIfDown = new Set([
    "false-fail",
    "false-pass-on-correct",
    "error-on-correct",
    "error-on-wrong",
    "review-on-correct",
    "review-on-wrong",
  ]);
  const isRegulatorCritical = new Set([
    "false-pass-on-correct",
    "false-fail",
  ]);
  let verdict = "≈ same";
  if (w22Mean < lower) {
    if (goodIfDown.has(bk)) verdict = "↓ improved";
    else if (goodIfUp.has(bk)) verdict = "↓ REGRESSED";
    else verdict = "↓ shift";
  } else if (w22Mean > upper) {
    if (goodIfUp.has(bk)) verdict = "↑ improved";
    else if (goodIfDown.has(bk)) {
      verdict = isRegulatorCritical.has(bk) ? "↑ CRITICAL REGRESSION" : "↑ regressed";
    } else verdict = "↑ shift";
  }
  // Collect into improved / regressed lists
  if (w22Mean < lower && goodIfDown.has(bk)) {
    improvedBuckets.push({ bucket: bk, baseline: b.mean, w22: w22Mean, delta: w22Mean - b.mean });
  }
  if (w22Mean > upper && goodIfUp.has(bk)) {
    improvedBuckets.push({ bucket: bk, baseline: b.mean, w22: w22Mean, delta: w22Mean - b.mean });
  }
  if (w22Mean > upper && goodIfDown.has(bk)) {
    regressedBuckets.push({ bucket: bk, baseline: b.mean, w22: w22Mean, delta: w22Mean - b.mean });
  }
  if (w22Mean < lower && goodIfUp.has(bk)) {
    regressedBuckets.push({ bucket: bk, baseline: b.mean, w22: w22Mean, delta: w22Mean - b.mean });
  }

  console.log(
    `${bk.padEnd(25)} ${baseStr.padEnd(22)} ` +
      vals.map((v) => v.toString().padEnd(8)).join("") +
      verdict,
  );
}

console.log();
console.log("Pre-registered acceptance: false-pass-on-correct must NOT regress");
const fp = baseline.stats["false-pass-on-correct"];
const fpVals = runs.map((r) => r.counts["false-pass-on-correct"] || 0);
const fpMean = fpVals.reduce((s, x) => s + x, 0) / fpVals.length;
const fpUpper = fp.mean + 2 * fp.sd;
if (fpMean <= fpUpper) {
  console.log(`  PASS: wave-22 mean fp-on-correct = ${fpMean.toFixed(2)} ≤ baseline upper ${fpUpper.toFixed(2)}`);
} else {
  console.log(`  FAIL: wave-22 mean fp-on-correct = ${fpMean.toFixed(2)} > baseline upper ${fpUpper.toFixed(2)}`);
}

console.log();
console.log("Improved buckets (outside 2σ in the favorable direction):");
if (improvedBuckets.length === 0) console.log("  (none)");
for (const x of improvedBuckets) {
  console.log(`  ${x.bucket}: baseline ${x.baseline.toFixed(1)} → wave-22 ${x.w22.toFixed(1)} (Δ ${x.delta > 0 ? "+" : ""}${x.delta.toFixed(1)})`);
}

console.log();
console.log("Regressed buckets (outside 2σ in the unfavorable direction):");
if (regressedBuckets.length === 0) console.log("  (none)");
for (const x of regressedBuckets) {
  console.log(`  ${x.bucket}: baseline ${x.baseline.toFixed(1)} → wave-22 ${x.w22.toFixed(1)} (Δ ${x.delta > 0 ? "+" : ""}${x.delta.toFixed(1)})`);
}

console.log();
console.log("Per-run summary (pass-rate-on-correct / fail-or-review-rate-on-wrong):");
for (let i = 0; i < runs.length; i++) {
  const s = runs[i].summary;
  console.log(`  run${i + 1}: passRateOnCorrect=${(s.passRateOnCorrect * 100).toFixed(1)}%, failOrReviewOnWrong=${(s.failOrReviewRateOnWrong * 100).toFixed(1)}%, p50=${s.latencyMs.p50_total}ms, p95=${s.latencyMs.p95_total}ms, errors=${s.errors}`);
}
