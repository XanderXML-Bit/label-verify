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
}

function parseArgs(argv: string[]): Args {
  const a: Args = { command: "", corpus: "test-data-combined", limit: 10, concurrency: 2, json: false, help: false };
  for (let i = 2; i < argv.length; i++) {
    const t = argv[i]!;
    if (t === "--json") a.json = true;
    else if (t === "--help" || t === "-h") a.help = true;
    else if (t === "--corpus") a.corpus = argv[++i] ?? a.corpus;
    else if (t === "--limit") a.limit = Number(argv[++i] ?? a.limit) || a.limit;
    else if (t === "--concurrency") a.concurrency = Number(argv[++i] ?? a.concurrency) || a.concurrency;
    else if (t === "--out") a.out = argv[++i];
    else if (!a.command) a.command = t;
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
  --help, -h                       Print this help.

Example: npm run bench:cross-pair -- --limit 5
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

  if (args.out) {
    await mkdir(dirname(args.out), { recursive: true });
    await writeFile(args.out, JSON.stringify(report, null, 2));
  }
  if (args.json) {
    process.stdout.write(JSON.stringify(report, null, 2) + "\n");
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
  /* eslint-enable no-console */
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
