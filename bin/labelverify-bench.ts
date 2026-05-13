#!/usr/bin/env tsx
// bin/labelverify-bench.ts
//
// Cross-pairing benchmark CLI. Runs every corpus image TWICE:
//   • against its correct ground-truth          → expected pass (or fail
//     if GT.government_warning is non-compliant). FAIL here = false-NEG.
//   • against the perturbed wrong GT            → expected fail/review.
//     PASS here = false-POSITIVE (matcher too lenient).
//
// Reports pass-rate-on-correct, fail-or-review-rate-on-wrong, P50/P95
// latency, and a per-`gov_warning_case` breakdown. Defaults --limit 10
// for safety; full 170×2 run is ~$0.10 + ~15 min at concurrency 2.

import { readFile, readdir, writeFile, mkdir } from "node:fs/promises";
import { existsSync, readFileSync } from "node:fs";
import { basename, dirname, join, resolve } from "node:path";
import { execFileSync } from "node:child_process";

function loadDotenv(path: string): void {
  if (!existsSync(path)) return;
  for (const raw of readFileSync(path, "utf8").split(/\r?\n/)) {
    const line = raw.trim();
    if (!line || line.startsWith("#")) continue;
    const eq = line.indexOf("=");
    if (eq < 0) continue;
    const k = line.slice(0, eq).trim();
    let v = line.slice(eq + 1).trim();
    if ((v.startsWith('"') && v.endsWith('"')) || (v.startsWith("'") && v.endsWith("'"))) {
      v = v.slice(1, -1);
    }
    if (process.env[k] === undefined) process.env[k] = v;
  }
}
loadDotenv(resolve(process.cwd(), ".env.local"));

interface Args {
  command: string;
  corpus: string;
  limit: number;
  concurrency: number;
  out?: string;
  json: boolean;
  help: boolean;
  /** When true, do not read or write `benchmarks/.best-known.json`.
   *  Useful for ad-hoc local runs the operator does NOT want to count
   *  as official records (e.g. testing a half-applied change). */
  noTrack: boolean;
}

function parseArgs(argv: string[]): Args {
  const a: Args = { command: "", corpus: "test-data-combined", limit: 10, concurrency: 2, json: false, help: false, noTrack: false };
  // Parse numeric flag with explicit Number.isFinite + non-negative check.
  // Earlier shape `Number(x) || default` silently swallowed `0` (falsy) —
  // breaking the advertised `--limit 0 = all` convention. Caught by
  // code-review audit 2026-05-13.
  function takeNumberArg(name: string, raw: string | undefined, current: number): number {
    if (raw === undefined) throw new Error(`${name} requires a value`);
    const n = Number(raw);
    if (!Number.isFinite(n) || n < 0) {
      throw new Error(`${name} must be a non-negative number (got "${raw}")`);
    }
    return n;
  }
  for (let i = 2; i < argv.length; i++) {
    const t = argv[i]!;
    if (t === "--json") a.json = true;
    else if (t === "--help" || t === "-h") a.help = true;
    else if (t === "--no-track") a.noTrack = true;
    else if (t === "--corpus") {
      const v = argv[++i];
      if (v === undefined) throw new Error("--corpus requires a directory path");
      a.corpus = v;
    } else if (t === "--limit") a.limit = takeNumberArg("--limit", argv[++i], a.limit);
    else if (t === "--concurrency") a.concurrency = takeNumberArg("--concurrency", argv[++i], a.concurrency);
    else if (t === "--out") {
      const v = argv[++i];
      if (v === undefined) throw new Error("--out requires a file path");
      a.out = v;
    } else if (!a.command) a.command = t;
  }
  return a;
}

function printHelp(): void {
  // eslint-disable-next-line no-console
  console.log(`LabelVerify cross-pair benchmark CLI

Commands:
  cross-pair                       Run every label against BOTH correct GT
                                   and perturbed wrong GT. Reports pass-rate-
                                   on-correct, fail/review-rate-on-wrong, and
                                   P50/P95 latency.

Flags:
  --corpus <dir>                   Corpus root (default: test-data-combined).
  --limit <N>                      Max images (default: 10; 0 = all).
  --concurrency <K>                Parallel verifies (default: 2).
  --out <path>                     Write JSON report to file.
  --json                           Emit JSON to stdout.
  --no-track                       Skip the best-known-record comparison
                                   (benchmarks/.best-known.json). Use for
                                   ad-hoc local runs you do not want to
                                   record as official records.
  --help, -h                       Print this help.

Example: npm run bench:cross-pair -- --limit 5

Regression tracking: by default the bench reads benchmarks/.best-known.json
and prints "NEW RECORD" / "REGRESSION" lines per metric so you see
immediately whether the current run is better than the prior best.
The file is updated only on improvements and is committed to the repo
so the champion travels with history.
`);
}

interface GtFile {
  id: string;
  image: string;
  gov_warning_case: string | null;
  fields: {
    brand_name: string;
    class_type: string;
    class_category: string;
    abv_percent: number;
    net_contents: { value: number; unit: string };
    producer: unknown;
    country_of_origin: string | null;
    government_warning?: {
      present: boolean;
      text_matches_regulation: boolean;
      prefix_all_caps: boolean;
      prefix_bold: boolean;
      meets_size_minimum: boolean;
    };
  };
}

type Condition = "correct" | "wrong";
type Verdict = "pass" | "fail" | "review" | "error";

interface CallRecord {
  image: string;
  condition: Condition;
  expected: Verdict;
  actual: Verdict;
  imageQuality: string;
  timings: import("../src/lib/types").VerifyTimings | null;
  elapsedMs: number;
  error?: string;
  govWarningCase?: string | null;
}

function isGtCompliant(gt: GtFile): boolean {
  // Truth-side compliance comes from the four GW booleans, not from
  // `gov_warning_case` (overloaded with image-quality tags — see
  // CHANGELOG 2026-05-13 mid).
  const w = gt.fields.government_warning;
  if (!w) return true;
  return w.present && w.text_matches_regulation && w.prefix_all_caps && w.prefix_bold && w.meets_size_minimum;
}

function toDeclared(gt: GtFile): import("../src/lib/types").DeclaredFields | null {
  const f = gt.fields;
  // GT.country_of_origin is null on some `ai-label-*` rows because Codex
  // couldn't visually confirm it. Skip those on the correct pass — there's
  // no honest expected verdict when the application has a null required field.
  if (typeof f.country_of_origin !== "string" || f.country_of_origin.length < 2) return null;
  return {
    brand_name: f.brand_name,
    class_type: f.class_type,
    class_category: f.class_category as "beer" | "wine" | "distilled_spirits" | "fortified_wine",
    abv_percent: f.abv_percent,
    net_contents: f.net_contents as { value: number; unit: "fl_oz" | "ml" | "L" | "cl" },
    producer: f.producer as string | import("../src/lib/types").DeclaredFields["producer"],
    country_of_origin: f.country_of_origin,
  };
}

function percentile(values: number[], q: number): number {
  if (values.length === 0) return 0;
  const sorted = [...values].sort((a, b) => a - b);
  return sorted[Math.min(sorted.length - 1, Math.floor(q * (sorted.length - 1)))] ?? 0;
}

async function cmdCrossPair(args: Args): Promise<void> {
  const apiKey = process.env.GOOGLE_API_KEY;
  if (!apiKey) throw new Error("GOOGLE_API_KEY not set — cross-pair runs real verifies.");
  const root = process.cwd();
  const corpusRoot = join(root, args.corpus);
  const labelsDir = join(corpusRoot, "labels");
  const truthsDir = join(corpusRoot, "ground-truth");
  const wrongDir = join(corpusRoot, "declared-wrong");
  if (!existsSync(wrongDir)) {
    throw new Error(
      `${wrongDir} missing — run \`tsx scripts/perturb-declared.ts --corpus ${args.corpus}\` first.`,
    );
  }

  const truthFiles = (await readdir(truthsDir))
    .filter((f) => f.endsWith(".json") && !f.startsWith("."))
    .sort();
  const slice = truthFiles.slice(0, args.limit > 0 ? args.limit : truthFiles.length);

  interface Task {
    id: string;
    imagePath: string;
    condition: Condition;
    gtPath: string;
    expectedVerdict: Verdict;
    govWarningCase: string | null;
  }
  const tasks: Task[] = [];
  for (const name of slice) {
    const gt = JSON.parse(await readFile(join(truthsDir, name), "utf8")) as GtFile;
    const stem = name.replace(/\.json$/, "");
    const imagePath = [`${stem}.png`, `${stem}.jpg`, `${stem}.jpeg`]
      .map((f) => join(labelsDir, f))
      .find((p) => existsSync(p));
    if (!imagePath) continue;
    const expectedCorrect: Verdict = isGtCompliant(gt) ? "pass" : "fail";
    tasks.push({ id: stem, imagePath, condition: "correct", gtPath: join(truthsDir, name), expectedVerdict: expectedCorrect, govWarningCase: gt.gov_warning_case });
    if (existsSync(join(wrongDir, name))) {
      tasks.push({ id: stem, imagePath, condition: "wrong", gtPath: join(wrongDir, name), expectedVerdict: "fail", govWarningCase: gt.gov_warning_case });
    }
  }

  if (!args.json) {
    // eslint-disable-next-line no-console
    console.log(`cross-pair: corpus=${args.corpus} images=${slice.length} tasks=${tasks.length} concurrency=${args.concurrency}`);
  }

  const { verifyLabel } = await import("../src/lib/verify");
  const { DeclaredFieldsSchema } = await import("../src/lib/types");

  const records: CallRecord[] = [];
  let cursor = 0;
  async function pump(): Promise<void> {
    while (true) {
      const i = cursor++;
      if (i >= tasks.length) return;
      const task = tasks[i]!;
      const t0 = Date.now();
      const push = (partial: Partial<CallRecord> & Pick<CallRecord, "actual" | "imageQuality">): void => {
        records.push({
          image: basename(task.imagePath),
          condition: task.condition,
          expected: task.expectedVerdict,
          timings: null,
          elapsedMs: Date.now() - t0,
          govWarningCase: task.govWarningCase,
          ...partial,
        });
      };
      try {
        const gt = JSON.parse(await readFile(task.gtPath, "utf8")) as GtFile;
        const declared = toDeclared(gt);
        if (!declared) {
          push({ actual: "error", imageQuality: "skipped", error: "GT missing required country_of_origin" });
          continue;
        }
        const validated = DeclaredFieldsSchema.safeParse(declared);
        if (!validated.success) {
          push({ actual: "error", imageQuality: "schema", error: validated.error.issues[0]?.message ?? "schema error" });
          continue;
        }
        const r = await verifyLabel(await readFile(task.imagePath), validated.data);
        push({ actual: r.verdict, imageQuality: r.imageQuality, timings: r.timings });
      } catch (err) {
        push({ actual: "error", imageQuality: "error", error: (err as Error).message });
      }
      if (!args.json) {
        const r = records[records.length - 1]!;
        // eslint-disable-next-line no-console
        console.log(`  [${records.length}/${tasks.length}] ${r.image} (${r.condition}): expected=${r.expected} actual=${r.actual} ${r.elapsedMs}ms`);
      }
    }
  }
  await Promise.all(Array.from({ length: Math.max(1, args.concurrency) }, () => pump()));

  // Summarize.
  const correct = records.filter((r) => r.condition === "correct" && r.actual !== "error");
  const wrong = records.filter((r) => r.condition === "wrong" && r.actual !== "error");
  const passOnCorrect = correct.filter((r) => r.actual === r.expected).length;
  const failOrReviewOnWrong = wrong.filter((r) => r.actual === "fail" || r.actual === "review").length;
  const totals = records.filter((r) => r.timings).map((r) => r.timings!.total);
  const visions = records.filter((r) => r.timings).map((r) => r.timings!.vision);

  const byCase = new Map<string, { correctPass: number; correctN: number; wrongFail: number; wrongN: number }>();
  for (const r of records) {
    if (r.actual === "error") continue;
    const key = r.govWarningCase ?? "PASS";
    const slot = byCase.get(key) ?? { correctPass: 0, correctN: 0, wrongFail: 0, wrongN: 0 };
    if (r.condition === "correct") {
      slot.correctN++;
      if (r.actual === r.expected) slot.correctPass++;
    } else {
      slot.wrongN++;
      if (r.actual === "fail" || r.actual === "review") slot.wrongFail++;
    }
    byCase.set(key, slot);
  }

  const summary = {
    corpus: args.corpus,
    runAt: new Date().toISOString(),
    images: slice.length,
    tasks: tasks.length,
    completed: records.length,
    errors: records.filter((r) => r.actual === "error").length,
    passRateOnCorrect: correct.length > 0 ? passOnCorrect / correct.length : 0,
    failOrReviewRateOnWrong: wrong.length > 0 ? failOrReviewOnWrong / wrong.length : 0,
    latencyMs: {
      p50_total: Math.round(percentile(totals, 0.5)),
      p95_total: Math.round(percentile(totals, 0.95)),
      p50_vision: Math.round(percentile(visions, 0.5)),
      p95_vision: Math.round(percentile(visions, 0.95)),
    },
    byCase: Object.fromEntries(
      [...byCase.entries()].map(([k, v]) => [
        k,
        {
          passRateOnCorrect: v.correctN > 0 ? v.correctPass / v.correctN : null,
          failOrReviewRateOnWrong: v.wrongN > 0 ? v.wrongFail / v.wrongN : null,
          n_correct: v.correctN,
          n_wrong: v.wrongN,
        },
      ]),
    ),
  };
  const report = { summary, records };

  // ─── Best-known-record tracking ──────────────────────────────────────────
  //
  // Compare this run's headline metrics against the per-metric
  // champions recorded in `benchmarks/.best-known.json`. For each
  // metric (higher-is-better or lower-is-better), if this run beats
  // the champion, update the record (with the current commit SHA and
  // bench filename) and emit a "NEW RECORD" line. If this run regresses,
  // emit a "REGRESSION" warning so the operator sees that something has
  // gotten worse before publishing the result.
  //
  // The file is committed to the repo so the champion travels with
  // history. Users running a one-off bench locally can opt out with
  // --no-track or by deleting the file.
  const trackingResult = await trackBestKnown(summary, args.corpus, args.noTrack);

  if (args.out) {
    await mkdir(dirname(args.out), { recursive: true });
    await writeFile(args.out, JSON.stringify(report, null, 2));
  }
  if (args.json) {
    process.stdout.write(
      JSON.stringify({ ...report, bestKnown: trackingResult }, null, 2) + "\n",
    );
    return;
  }
  /* eslint-disable no-console */
  console.log(`\nCross-pair summary:`);
  console.log(`  pass-rate on CORRECT GT:        ${(summary.passRateOnCorrect * 100).toFixed(1)}% (${passOnCorrect}/${correct.length})`);
  console.log(`  fail/review-rate on WRONG GT:   ${(summary.failOrReviewRateOnWrong * 100).toFixed(1)}% (${failOrReviewOnWrong}/${wrong.length})`);
  console.log(`  errors:                         ${summary.errors}`);
  console.log(`  latency P50/P95 (total):        ${summary.latencyMs.p50_total} / ${summary.latencyMs.p95_total} ms`);
  console.log(`  latency P50/P95 (vision):       ${summary.latencyMs.p50_vision} / ${summary.latencyMs.p95_vision} ms`);
  if (Object.keys(summary.byCase).length > 1) {
    console.log(`\n  By gov_warning_case:`);
    for (const [k, v] of Object.entries(summary.byCase)) {
      const pc = (x: number | null): string => (x === null ? "—" : `${(x * 100).toFixed(0)}%`);
      console.log(`    ${k.padEnd(14)} correct→pass ${pc(v.passRateOnCorrect).padStart(5)} (n=${v.n_correct})   wrong→fail/review ${pc(v.failOrReviewRateOnWrong).padStart(5)} (n=${v.n_wrong})`);
    }
  }
  if (args.out) console.log(`\n  Wrote ${args.out}`);
  if (trackingResult.improvements.length > 0 || trackingResult.regressions.length > 0) {
    console.log(`\n  Best-known-record comparison (benchmarks/.best-known.json):`);
    for (const imp of trackingResult.improvements) {
      console.log(
        `    [+] NEW RECORD: ${imp.metric} ${formatMetric(imp.metric, imp.from)} -> ${formatMetric(imp.metric, imp.to)}`,
      );
    }
    for (const reg of trackingResult.regressions) {
      console.log(
        `    [!] REGRESSION: ${reg.metric} ${formatMetric(reg.metric, reg.from)} -> ${formatMetric(reg.metric, reg.to)} (best stays ${formatMetric(reg.metric, reg.from)} at ${reg.bestCommit.slice(0, 7)})`,
      );
    }
  } else {
    console.log(`\n  Best-known-record comparison: no metric changed.`);
  }
  /* eslint-enable no-console */
}

// ─── Best-known-record tracking helpers ─────────────────────────────────────

interface MetricChampion {
  value: number;
  commit: string;
  benchAt: string;
  corpus: string;
}

interface BestKnownFile {
  champions: Record<string, MetricChampion>;
}

const METRIC_DIRECTION: Record<string, "higher-better" | "lower-better"> = {
  passRateOnCorrect: "higher-better",
  failOrReviewRateOnWrong: "higher-better",
  p50_total: "lower-better",
  p95_total: "lower-better",
  p50_vision: "lower-better",
  p95_vision: "lower-better",
  errors: "lower-better",
};

function formatMetric(metric: string, value: number): string {
  if (metric.startsWith("p")) return `${Math.round(value)} ms`;
  if (metric === "errors") return String(Math.round(value));
  return `${(value * 100).toFixed(1)}%`;
}

function gitHeadShort(): string {
  // execFileSync with a constant arg list (no shell, no user input)
  // satisfies the no-shell-injection rule; gives the champion record
  // the git commit it was achieved at for provenance.
  try {
    return execFileSync("git", ["rev-parse", "HEAD"], { encoding: "utf8" }).trim();
  } catch {
    return "no-git";
  }
}

interface TrackingResult {
  improvements: Array<{ metric: string; from: number; to: number }>;
  regressions: Array<{
    metric: string;
    from: number;
    to: number;
    bestCommit: string;
  }>;
  unchanged: string[];
}

async function trackBestKnown(
  summary: {
    corpus: string;
    passRateOnCorrect: number;
    failOrReviewRateOnWrong: number;
    errors: number;
    latencyMs: {
      p50_total: number;
      p95_total: number;
      p50_vision: number;
      p95_vision: number;
    };
  },
  corpus: string,
  noTrack: boolean,
): Promise<TrackingResult> {
  const result: TrackingResult = {
    improvements: [],
    regressions: [],
    unchanged: [],
  };
  if (noTrack) return result;

  const filePath = resolve("benchmarks/.best-known.json");
  let file: BestKnownFile = { champions: {} };
  if (existsSync(filePath)) {
    try {
      file = JSON.parse(readFileSync(filePath, "utf8")) as BestKnownFile;
      if (!file.champions) file.champions = {};
    } catch {
      // Corrupt file — start fresh rather than crash the bench.
      file = { champions: {} };
    }
  }

  const candidates: Record<string, number> = {
    passRateOnCorrect: summary.passRateOnCorrect,
    failOrReviewRateOnWrong: summary.failOrReviewRateOnWrong,
    p50_total: summary.latencyMs.p50_total,
    p95_total: summary.latencyMs.p95_total,
    p50_vision: summary.latencyMs.p50_vision,
    p95_vision: summary.latencyMs.p95_vision,
    errors: summary.errors,
  };
  const commit = gitHeadShort();
  const now = new Date().toISOString();

  for (const [metric, candidateValue] of Object.entries(candidates)) {
    const direction = METRIC_DIRECTION[metric] ?? "higher-better";
    const champion = file.champions[metric];
    const sameCorpus = champion && champion.corpus === corpus;
    if (!sameCorpus) {
      // No champion or different corpus: this is the new baseline for
      // this corpus. Record without flagging (first-runs shouldn't
      // emit improvement/regression noise).
      file.champions[metric] = {
        value: candidateValue,
        commit,
        benchAt: now,
        corpus,
      };
      continue;
    }
    const isImprovement =
      direction === "higher-better"
        ? candidateValue > champion.value
        : candidateValue < champion.value;
    const isRegression =
      direction === "higher-better"
        ? candidateValue < champion.value
        : candidateValue > champion.value;
    if (isImprovement) {
      result.improvements.push({
        metric,
        from: champion.value,
        to: candidateValue,
      });
      file.champions[metric] = {
        value: candidateValue,
        commit,
        benchAt: now,
        corpus,
      };
    } else if (isRegression) {
      result.regressions.push({
        metric,
        from: champion.value,
        to: candidateValue,
        bestCommit: champion.commit,
      });
    } else {
      result.unchanged.push(metric);
    }
  }

  await writeFile(filePath, JSON.stringify(file, null, 2) + "\n");
  return result;
}

async function main(): Promise<void> {
  const args = parseArgs(process.argv);
  if (args.help || !args.command) {
    printHelp();
    return;
  }
  try {
    if (args.command === "cross-pair") {
      await cmdCrossPair(args);
    } else {
      // eslint-disable-next-line no-console
      console.error(`Unknown command: ${args.command}\n`);
      printHelp();
      process.exit(2);
    }
  } catch (err) {
    // eslint-disable-next-line no-console
    console.error(`Error: ${(err as Error).message}`);
    process.exit(1);
  }
}

void main();
