import { describe, expect, it } from "vitest";
import { readFileSync, existsSync, readdirSync } from "node:fs";
import { join } from "node:path";

// Per REMAINING-IMPROVEMENTS.md T4: sanity check on the most recent
// bench result. If any (beverage_type × condition × field) stratum
// returns 0 % accuracy over n ≥ 20, that's almost certainly a
// systematic data error (e.g. ground-truth field rename, extractor
// returning null for a whole class of inputs) rather than a model
// error. Catching this in CI prevents shipping a regression.
//
// The test reads the newest `benchmarks/results/*.json` summary if
// present and walks every technique's `stratified` table. Skips
// cleanly when no bench result exists (a fresh clone has none).

interface StratumRow {
  strata: Record<string, string>;
  acc: { acc: number; ciLo: number; ciHi: number; n: number };
}

interface TechSummary {
  id: string;
  skipped: { reason: string } | null;
  stratified: StratumRow[];
}

interface BenchSummary {
  techniques: TechSummary[];
}

function findLatestSummary(): BenchSummary | null {
  const dir = join(process.cwd(), "benchmarks", "results");
  if (!existsSync(dir)) return null;
  const files = readdirSync(dir)
    .filter(
      (f) =>
        f.endsWith(".json") &&
        !f.endsWith("-per-image.json") &&
        // The cross-pair bench (wave-13) writes a different schema
        // (summary + records[]) than the technique-bench this test
        // was written for (techniques[].stratified[]). Skip those
        // files explicitly rather than fail parsing on the wrong
        // shape — the cross-pair bench has its own per-image trace
        // (`cross-pair-<iso>.md`) and aggregate (`aggregate-<iso>.md`).
        !f.startsWith("cross-pair-") &&
        !f.startsWith("aggregate-") &&
        // Wave-22 (and any future wave-N cross-pair replicate set)
        // also writes the cross-pair schema but to an explicit
        // `--out` path that doesn't start with `cross-pair-`. Same
        // skip rationale.
        !f.startsWith("wave") &&
        // baseline-N8-stats.json is a manually-rolled aggregate of
        // bucket counts (different schema again). Skip.
        !f.startsWith("baseline-"),
    )
    .sort();
  if (files.length === 0) return null;
  // Defensive last-mile: even after the filename filters, walk the
  // most recent files until we find one that actually has the
  // technique-bench shape. Catches any future bench output that
  // accidentally collides with the technique filename prefix.
  for (let i = files.length - 1; i >= 0; i--) {
    const text = readFileSync(join(dir, files[i]!), "utf8");
    let parsed: unknown;
    try {
      parsed = JSON.parse(text);
    } catch {
      continue;
    }
    if (
      typeof parsed === "object" &&
      parsed !== null &&
      Array.isArray((parsed as BenchSummary).techniques)
    ) {
      return parsed as BenchSummary;
    }
  }
  return null;
}

describe("Bench result stratified sanity (REMAINING-IMPROVEMENTS T4)", () => {
  const summary = findLatestSummary();

  it.runIf(summary !== null)(
    "no stratum is at 0 % accuracy over n ≥ 20 across any technique",
    () => {
      const offenders: Array<{ tech: string; strata: Record<string, string>; n: number }> = [];
      for (const tech of summary!.techniques) {
        if (tech.skipped) continue;
        for (const row of tech.stratified) {
          if (row.acc.n >= 20 && row.acc.acc === 0) {
            offenders.push({ tech: tech.id, strata: row.strata, n: row.acc.n });
          }
        }
      }
      if (offenders.length > 0) {
        // Build a rich failure message so CI logs name the bad stratum.
        const lines = offenders.map(
          (o) => `  ${o.tech}: ${JSON.stringify(o.strata)} (n=${o.n})`,
        );
        throw new Error(
          `Found ${offenders.length} stratum/strata with 0 % accuracy over n ≥ 20:\n` +
            lines.join("\n") +
            "\nThis is almost certainly a systematic data error — check the ground-truth and extractor for that combination.",
        );
      }
    },
  );

  // A weaker sanity check that ALWAYS runs (even without a bench result):
  // the test fixture itself must not be misshapen.
  it("test harness can parse a bench result if one exists", () => {
    if (summary === null) {
      // benign — nothing to assert
      return;
    }
    expect(Array.isArray(summary.techniques)).toBe(true);
    for (const tech of summary.techniques) {
      expect(typeof tech.id).toBe("string");
      expect(Array.isArray(tech.stratified)).toBe(true);
    }
  });
});
