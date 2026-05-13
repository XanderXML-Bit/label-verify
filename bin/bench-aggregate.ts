#!/usr/bin/env tsx
// bin/bench-aggregate.ts
//
// Aggregator for N replicate cross-pair bench runs. Computes
// mean ± SD for each headline metric and a per-image consistency
// table that distinguishes DETERMINISTIC_FAIL (real, reproducible
// verifier bugs worth investigating) from FLIPPER (noisy verifier
// outputs that sample size, not bug-fixing, is the right tool for).
//
// Usage:
//   tsx bin/bench-aggregate.ts <run1.json> <run2.json> ... <runN.json>
//
// Or accept all `cross-pair-*.json` under benchmarks/results/:
//   tsx bin/bench-aggregate.ts --glob
//
// Output: a Markdown report with the noise band and consistency
// table, printed to stdout. Also writes the report under
// `benchmarks/results/aggregate-<iso>.md` for future reference.

import { readFile, writeFile, readdir, mkdir } from "node:fs/promises";
import { resolve, join, basename, dirname } from "node:path";
import { existsSync } from "node:fs";
import {
  aggregateRuns,
  perImageConsistency,
  type Bucket,
  type RunInput,
} from "../src/lib/bench-aggregate";

interface Args {
  files: string[];
  glob: boolean;
  help: boolean;
}

function parseArgs(argv: string[]): Args {
  const a: Args = { files: [], glob: false, help: false };
  for (let i = 2; i < argv.length; i++) {
    const t = argv[i]!;
    if (t === "--help" || t === "-h") a.help = true;
    else if (t === "--glob") a.glob = true;
    else a.files.push(t);
  }
  return a;
}

function printHelp(): void {
  console.log(`bench-aggregate — aggregate N replicate cross-pair runs

Usage:
  tsx bin/bench-aggregate.ts <run1.json> [<run2.json> ...]
  tsx bin/bench-aggregate.ts --glob       (read all cross-pair-*.json)

Outputs:
  - Noise band: mean ± SD per headline metric
  - Per-image consistency table: DETERMINISTIC_FAIL vs FLIPPER vs ...
  - Writes a Markdown report to benchmarks/results/aggregate-<iso>.md.
`);
}

interface JsonFile {
  summary: {
    runAt: string;
    passRateOnCorrect: number;
    failOrReviewRateOnWrong: number;
    errors: number;
    latencyMs: {
      p50_total: number;
      p95_total: number;
      p50_vision: number;
      p95_vision: number;
    };
  };
  records: Array<{
    image: string;
    condition: "correct" | "wrong";
    bucket?: Bucket;
    actual: string;
    expected: string;
  }>;
}

async function main(): Promise<void> {
  const args = parseArgs(process.argv);
  if (args.help) {
    printHelp();
    return;
  }

  const root = process.cwd();
  let paths = args.files.map((p) => resolve(p));
  if (args.glob) {
    const dir = join(root, "benchmarks", "results");
    if (!existsSync(dir)) {
      throw new Error(`${dir} does not exist`);
    }
    const all = await readdir(dir);
    paths = all
      .filter(
        (f) =>
          f.startsWith("cross-pair-") &&
          f.endsWith(".json") &&
          !f.endsWith("-per-image.json"),
      )
      .map((f) => join(dir, f))
      .sort();
  }
  if (paths.length === 0) {
    throw new Error(
      "No input files. Pass JSON paths or --glob to read benchmarks/results/cross-pair-*.json.",
    );
  }

  const runs: RunInput[] = [];
  const runIds: string[] = [];
  for (const p of paths) {
    const raw = await readFile(p, "utf8");
    let parsed: JsonFile;
    try {
      parsed = JSON.parse(raw) as JsonFile;
    } catch {
      console.error(`Skipping ${p}: not valid JSON`);
      continue;
    }
    if (!parsed.summary || !parsed.records) {
      console.error(`Skipping ${p}: missing summary or records`);
      continue;
    }
    runs.push({
      summary: parsed.summary,
      records: parsed.records
        .filter((r): r is typeof r & { bucket: Bucket } => !!r.bucket)
        .map((r) => ({
          image: r.image,
          condition: r.condition,
          bucket: r.bucket,
        })),
    });
    runIds.push(basename(p, ".json"));
  }

  if (runs.length === 0) {
    throw new Error("No usable runs found.");
  }

  const agg = aggregateRuns(runs);
  const consistency = perImageConsistency(runs);

  const md = renderMarkdown({ runIds, agg, consistency });
  console.log(md);

  const isoSlug = new Date().toISOString().replace(/[:.]/g, "-");
  const outPath = join(root, "benchmarks", "results", `aggregate-${isoSlug}.md`);
  await mkdir(dirname(outPath), { recursive: true });
  await writeFile(outPath, md);
  console.error(`\nWrote ${outPath}`);
}

function renderMarkdown(input: {
  runIds: string[];
  agg: ReturnType<typeof aggregateRuns>;
  consistency: ReturnType<typeof perImageConsistency>;
}): string {
  const { runIds, agg, consistency } = input;
  const lines: string[] = [];
  lines.push(`# Cross-pair bench — replicate aggregate`);
  lines.push(``);
  lines.push(`- N = ${agg.passRateOnCorrect.n} replicate runs`);
  lines.push(`- Sources:`);
  for (const id of runIds) lines.push(`  - \`${id}\``);
  lines.push(``);
  lines.push(`## Noise band (mean ± sample SD)`);
  lines.push(``);
  lines.push(`| Metric | Mean | SD | Min | Max | 2σ band |`);
  lines.push(`|---|---:|---:|---:|---:|---:|`);
  for (const [label, m] of [
    ["passRateOnCorrect (%)", scaled(agg.passRateOnCorrect, 100, 1)],
    ["failOrReviewRateOnWrong (%)", scaled(agg.failOrReviewRateOnWrong, 100, 1)],
    ["errors (count)", scaled(agg.errors, 1, 1)],
    ["p50_total (ms)", scaled(agg.p50_total, 1, 0)],
    ["p95_total (ms)", scaled(agg.p95_total, 1, 0)],
    ["p50_vision (ms)", scaled(agg.p50_vision, 1, 0)],
    ["p95_vision (ms)", scaled(agg.p95_vision, 1, 0)],
  ] as const) {
    lines.push(
      `| ${label} | ${m.mean} | ${m.sd} | ${m.min} | ${m.max} | ±${m.twoSigma} |`,
    );
  }
  lines.push(``);
  lines.push(
    `> An effect-size claim ("the change improved pass-rate by Δ pp") must show |Δ| > 2σ to be defensible. Smaller deltas are within noise; the right next step is more samples, not a code change.`,
  );
  lines.push(``);

  // Consistency tables — group by classification.
  const byClass: Record<string, typeof consistency> = {};
  for (const row of consistency) {
    (byClass[row.classification] ??= []).push(row);
  }
  // Surface DETERMINISTIC_FAIL + DETERMINISTIC_ERROR first — those
  // are the actionable bug list.
  const order = [
    "DETERMINISTIC_FAIL",
    "DETERMINISTIC_ERROR",
    "INCONSISTENT_NON_PASS",
    "FLIPPER",
    "DETERMINISTIC_PASS",
  ];
  for (const cls of order) {
    const rows = byClass[cls];
    if (!rows || rows.length === 0) continue;
    lines.push(`## ${cls} — ${rows.length} (image, condition) pairs`);
    lines.push(``);
    if (
      cls === "DETERMINISTIC_FAIL" ||
      cls === "DETERMINISTIC_ERROR" ||
      cls === "INCONSISTENT_NON_PASS"
    ) {
      lines.push(`| Image | Condition | Times observed | Bucket distribution |`);
      lines.push(`|---|---|---:|---|`);
      for (const r of rows) {
        const dist = Object.entries(r.bucketCounts)
          .sort(([, a], [, b]) => (b ?? 0) - (a ?? 0))
          .map(([b, c]) => `\`${b}\` ×${c}`)
          .join(", ");
        lines.push(
          `| \`${r.image}\` | ${r.condition} | ${r.timesObserved} | ${dist} |`,
        );
      }
    } else {
      // FLIPPER + DETERMINISTIC_PASS — show count + sample, not full
      // list. The PASS bucket is usually the largest (~150 rows).
      lines.push(
        `- Count: ${rows.length} — sample: ${rows
          .slice(0, 5)
          .map((r) => `\`${r.image}\` (${r.condition})`)
          .join(", ")}${rows.length > 5 ? `, …` : ""}`,
      );
    }
    lines.push(``);
  }

  return lines.join("\n");
}

function scaled(
  m: { n: number; mean: number; sd: number; min: number; max: number },
  factor: number,
  decimals: number,
): { mean: string; sd: string; min: string; max: string; twoSigma: string } {
  const fmt = (x: number): string => (x * factor).toFixed(decimals);
  return {
    mean: fmt(m.mean),
    sd: fmt(m.sd),
    min: fmt(m.min),
    max: fmt(m.max),
    twoSigma: fmt(2 * m.sd),
  };
}

main().catch((err) => {
  console.error((err as Error).message);
  process.exit(1);
});
