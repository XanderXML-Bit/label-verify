// Wave-27 primary-model bake-off comparison.
//
// Inputs: benchmarks/results/bakeoff/<model>-run<N>.json
// Output: per-model bucket counts (mean, range), pass-rate-on-correct,
// fail-or-review-on-wrong, p50/p95 latency, error count, vision-only
// latency, ranked side-by-side.

const fs = require("node:fs");
const path = require("node:path");

const DIR = __dirname;

const MODELS = [
  "gemini-3.1-flash-lite",
  "gemini-2.5-flash",
  "gemini-3-flash-preview",
];

const BUCKETS = [
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

function loadRuns(model) {
  const files = fs
    .readdirSync(DIR)
    .filter((f) => f.startsWith(`${model}-run`) && f.endsWith(".json"))
    .map((f) => path.join(DIR, f));
  return files.map((f) => JSON.parse(fs.readFileSync(f, "utf8")));
}

function countBuckets(runs) {
  const totals = {};
  for (const bk of BUCKETS) totals[bk] = [];
  for (const r of runs) {
    const counts = {};
    for (const rec of r.records || []) {
      counts[rec.bucket] = (counts[rec.bucket] || 0) + 1;
    }
    for (const bk of BUCKETS) totals[bk].push(counts[bk] || 0);
  }
  return totals;
}

function stat(arr) {
  if (arr.length === 0) return { mean: 0, min: 0, max: 0, n: 0 };
  const m = arr.reduce((s, x) => s + x, 0) / arr.length;
  return { mean: m, min: Math.min(...arr), max: Math.max(...arr), n: arr.length };
}

function fmt(s) {
  if (s.min === s.max) return `${s.mean.toFixed(1)} (n=${s.n})`;
  return `${s.mean.toFixed(1)} [${s.min}-${s.max}]`;
}

const data = {};
for (const m of MODELS) {
  const runs = loadRuns(m);
  if (runs.length === 0) {
    console.log(`(no runs found for ${m})`);
    continue;
  }
  data[m] = {
    n: runs.length,
    buckets: countBuckets(runs),
    summaries: runs.map((r) => r.summary),
  };
}

const found = Object.keys(data);
if (found.length === 0) {
  console.log("No bakeoff runs found.");
  process.exit(0);
}

// Bucket table
console.log("\n=== Wave-27 primary bake-off (second-opinion disabled) ===\n");
console.log(
  `${"bucket".padEnd(25)} ${MODELS.map((m) => m.padEnd(28)).join("")}`,
);
console.log("-".repeat(25 + MODELS.length * 28));
for (const bk of BUCKETS) {
  const cells = MODELS.map((m) => {
    if (!data[m]) return "—".padEnd(28);
    return fmt(stat(data[m].buckets[bk] || [])).padEnd(28);
  });
  console.log(`${bk.padEnd(25)} ${cells.join("")}`);
}

// Rate table
console.log("\n--- Pass-rate / fail-or-review rate ---");
for (const m of MODELS) {
  if (!data[m]) continue;
  const pr = data[m].summaries.map((s) => s.passRateOnCorrect * 100);
  const fr = data[m].summaries.map((s) => s.failOrReviewRateOnWrong * 100);
  const err = data[m].summaries.map((s) => s.errors);
  console.log(
    `${m.padEnd(28)} pass-rate-on-correct = ${stat(pr).mean.toFixed(1)}% [${stat(pr).min.toFixed(1)}-${stat(pr).max.toFixed(1)}]  fail-or-review-on-wrong = ${stat(fr).mean.toFixed(1)}%  errors = ${stat(err).mean.toFixed(1)}`,
  );
}

// Latency table
console.log("\n--- Latency (ms) ---");
for (const m of MODELS) {
  if (!data[m]) continue;
  const p50t = data[m].summaries.map((s) => s.latencyMs.p50_total);
  const p95t = data[m].summaries.map((s) => s.latencyMs.p95_total);
  const p50v = data[m].summaries.map((s) => s.latencyMs.p50_vision);
  const p95v = data[m].summaries.map((s) => s.latencyMs.p95_vision);
  console.log(
    `${m.padEnd(28)} total p50=${stat(p50t).mean.toFixed(0)} p95=${stat(p95t).mean.toFixed(0)}   vision p50=${stat(p50v).mean.toFixed(0)} p95=${stat(p95v).mean.toFixed(0)}`,
  );
}

// Ranking
function rank(metric, key, lowerBetter = false) {
  const vs = MODELS.filter((m) => data[m]).map((m) => ({
    model: m,
    val: key(data[m]),
  }));
  vs.sort((a, b) => (lowerBetter ? a.val - b.val : b.val - a.val));
  console.log(`\n${metric}:`);
  vs.forEach((v, i) =>
    console.log(`  ${i + 1}. ${v.model.padEnd(28)} ${v.val.toFixed(2)}`),
  );
}

rank("Pass-rate-on-correct (higher better)", (d) =>
  d.summaries.reduce((s, x) => s + x.passRateOnCorrect, 0) / d.summaries.length * 100,
);
rank("False-fail count (lower better)", (d) =>
  stat(d.buckets["false-fail"]).mean,
true);
rank("False-pass-on-correct count (lower better — REGULATOR-CRITICAL)", (d) =>
  stat(d.buckets["false-pass-on-correct"]).mean,
true);
rank("True-reject count (higher better — sharper rejection)", (d) =>
  stat(d.buckets["true-reject"]).mean,
);
rank("Vision p50 latency (lower better)", (d) =>
  d.summaries.reduce((s, x) => s + x.latencyMs.p50_vision, 0) / d.summaries.length,
true);
rank("Vision p95 latency (lower better)", (d) =>
  d.summaries.reduce((s, x) => s + x.latencyMs.p95_vision, 0) / d.summaries.length,
true);
