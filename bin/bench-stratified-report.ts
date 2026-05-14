#!/usr/bin/env tsx
// bin/bench-stratified-report.ts
//
// Stratified-guardrail re-analysis. Reads one or more cross-pair bench
// JSON files (output of `bin/labelverify-bench.ts cross-pair --json
// --out ...`) and emits per-stratum bucket counts, so the stratified
// pre-registered guardrail can be applied:
//
//   compliant stratum  (real-photo C0 + synthetic "compliant" + PASS):
//     - false-pass-on-correct must NOT increase (regulator-critical)
//     - false-fail must NOT increase
//   adversarial stratum (B/S/T/C[!=C0]/X/non-compliant-*):
//     - bounded budget on false-pass-on-correct (configurable)
//   quality stratum (Q*-prefixed):
//     - REVIEW routing test, not compliance — separate budget
//
// Usage:
//   tsx bin/bench-stratified-report.ts <run.json> [<run2.json> ...]

import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import {
  stratify,
  stratifiedCounts,
  type BenchStratum,
} from "../src/lib/bench-stratify";

interface BenchRecord {
  image: string;
  condition: "correct" | "wrong";
  expected: string;
  actual: string;
  bucket?: string;
  govWarningCase?: string | null;
}

interface BenchOutput {
  summary?: {
    passRateOnCorrect?: number;
    failOrReviewRateOnWrong?: number;
    latencyMs?: { p50_total: number; p95_total: number };
  };
  records?: BenchRecord[];
}

const STRATA: BenchStratum[] = ["compliant", "adversarial", "quality", "unknown"];
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

const inputs = process.argv.slice(2);
if (inputs.length === 0) {
  console.error(
    "Usage: tsx bin/bench-stratified-report.ts <run.json> [<run2.json> ...]",
  );
  process.exit(1);
}

function loadCorrectRecords(path: string): BenchRecord[] {
  const raw = readFileSync(resolve(path), "utf8");
  const j = JSON.parse(raw) as BenchOutput;
  const recs = j.records ?? [];
  return recs.filter((r) => r.condition === "correct");
}

function fmtCount(n: number, total: number): string {
  if (total === 0) return n.toString();
  return `${n} (${((n / total) * 100).toFixed(1)}%)`;
}

console.log("\n=== Stratified bench report ===\n");

for (const path of inputs) {
  const correct = loadCorrectRecords(path);
  const grouped = stratifiedCounts(correct);
  const label = path.split(/[\\/]/).slice(-1)[0];
  console.log(`\n--- ${label} ---`);
  console.log(
    `${"bucket".padEnd(25)} ${STRATA.map((s) => s.padEnd(14)).join("")}`,
  );
  console.log("-".repeat(25 + STRATA.length * 14));
  for (const bk of BUCKETS) {
    const cells = STRATA.map((s) => {
      const c = grouped[s].buckets[bk] || 0;
      const n = grouped[s].n;
      return fmtCount(c, n).padEnd(14);
    });
    console.log(`${bk.padEnd(25)} ${cells.join("")}`);
  }
  console.log(
    `${"(stratum total)".padEnd(25)} ${STRATA.map((s) => grouped[s].n.toString().padEnd(14)).join("")}`,
  );
}
