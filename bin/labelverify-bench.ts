#!/usr/bin/env tsx
// bin/labelverify-bench.ts
//
// A third CLI surface dedicated to the cross-pairing benchmark. Where
// `bin/labelverify.ts batch` runs the production pipeline over a folder
// of (image, application) pairs, this binary runs every corpus image
// TWICE — once against its correct ground-truth and once against the
// programmatically-perturbed "wrong" declared-fields file produced by
// `scripts/perturb-declared.ts`. The two passes catch opposite errors:
//
//   • correct GT  → expected verdict = pass (or whatever GT says)
//                   FAIL/REVIEW here = false-negative.
//   • wrong GT    → expected verdict = fail or review
//                   PASS here = false-positive (matcher is too lenient).
//
// Output: a structured JSON report (per-call rows + summary metrics).
// Defaults to --limit 10 because a full 170×2 run is expensive (~$0.10
// in vision USD + ~15 min wall-clock at concurrency 2).
//
// Usage:
//   tsx bin/labelverify-bench.ts cross-pair --corpus test-data-combined
//   tsx bin/labelverify-bench.ts cross-pair --corpus test-data-combined --limit 5 --json
//   npm run bench:cross-pair -- --limit 10

import { readFile, readdir, writeFile, mkdir } from "node:fs/promises";
import { existsSync, readFileSync } from "node:fs";
import { basename, dirname, join, resolve } from "node:path";

// ─── .env.local loader ──────────────────────────────────────────────────────

function loadDotenv(path: string): void {
  if (!existsSync(path)) return;
  const text = readFileSync(path, "utf8");
  for (const raw of text.split(/\r?\n/)) {
    const line = raw.trim();
    if (!line || line.startsWith("#")) continue;
    const eq = line.indexOf("=");
    if (eq < 0) continue;
    const k = line.slice(0, eq).trim();
    let v = line.slice(eq + 1).trim();
    if (
      (v.startsWith('"') && v.endsWith('"')) ||
      (v.startsWith("'") && v.endsWith("'"))
    ) {
      v = v.slice(1, -1);
    }
    if (process.env[k] === undefined) process.env[k] = v;
  }
}
loadDotenv(resolve(process.cwd(), ".env.local"));

// ─── Args ───────────────────────────────────────────────────────────────────

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
  const args: Args = {
    command: "",
    corpus: "test-data-combined",
    limit: 10,
    concurrency: 2,
    json: false,
    help: false,
  };
  for (let i = 2; i < argv.length; i++) {
    const a = argv[i]!;
    if (a === "--json") args.json = true;
    else if (a === "--help" || a === "-h") args.help = true;
    else if (a === "--corpus") args.corpus = argv[++i] ?? args.corpus;
    else if (a === "--limit") args.limit = Number(argv[++i] ?? args.limit) || args.limit;
    else if (a === "--concurrency")
      args.concurrency = Number(argv[++i] ?? args.concurrency) || args.concurrency;
    else if (a === "--out") args.out = argv[++i];
    else if (!args.command) args.command = a;
  }
  return args;
}

function printHelp(): void {
  // eslint-disable-next-line no-console
  console.log(
    `LabelVerify cross-pair benchmark CLI

Commands:
  cross-pair                       Run every label image against BOTH its
                                   correct GT and its perturbed "wrong" GT.
                                   Reports pass-rate-on-correct and
                                   fail-or-review-rate-on-wrong, plus
                                   latency percentiles.

Flags:
  --corpus <dir>                   Corpus root containing ./labels,
                                   ./ground-truth, and ./declared-wrong
                                   (default: test-data-combined).
  --limit <N>                      Max images to run (default: 10).
                                   Set to 0 for the full corpus.
  --concurrency <K>                Parallel verifies (default: 2).
  --out <path>                     Write the JSON report to a file in
                                   addition to stdout summary.
  --json                           Emit JSON report to stdout (otherwise
                                   prints a human-readable summary table).
  --help, -h                       Print this help.

Examples:
  npm run bench:cross-pair -- --limit 5
  tsx bin/labelverify-bench.ts cross-pair --limit 0 --out reports/cross-pair.json
`,
  );
}

// ─── Types ──────────────────────────────────────────────────────────────────

interface GtFile {
  id: string;
  image: string;
  gov_warning_case: string | null;
  fields: Record<string, unknown> & {
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
  timings: {
    preprocess: number;
    ocr: number | null;
    vision: number;
    matching: number;
    total: number;
  } | null;
  elapsedMs: number;
  error?: string;
  govWarningCase?: string | null;
}

// ─── Helpers ────────────────────────────────────────────────────────────────

function isGtCompliant(gt: GtFile): boolean {
  // Truth-side compliance is derived from the four GW booleans, NOT from
  // gov_warning_case (which is overloaded with image-quality tags — see
  // CHANGELOG 2026-05-13 mid). All booleans true ⇒ pass; else fail.
  const w = gt.fields.government_warning;
  if (!w) return true;
  return (
    w.present &&
    w.text_matches_regulation &&
    w.prefix_all_caps &&
    w.prefix_bold &&
    w.meets_size_minimum
  );
}

function toDeclared(
  gt: GtFile,
): import("../src/lib/types").DeclaredFields | null {
  // Coerce GT fields into the strict DeclaredFieldsSchema shape. Returns
  // null when GT is missing data the schema requires (country_of_origin
  // is non-null on syn/deg; some `ai-label-*` have it set to null because
  // Codex couldn't visually confirm — those rows are skipped on the
  // "correct" pass because there's no honest expected verdict).
  const f = gt.fields;
  if (typeof f.country_of_origin !== "string" || f.country_of_origin.length < 2) {
    return null;
  }
  return {
    brand_name: f.brand_name,
    class_type: f.class_type,
    class_category: f.class_category as
      | "beer"
      | "wine"
      | "distilled_spirits"
      | "fortified_wine",
    abv_percent: f.abv_percent,
    net_contents: f.net_contents as { value: number; unit: "fl_oz" | "ml" | "L" | "cl" },
    producer: f.producer as string | import("../src/lib/types").DeclaredFields["producer"],
    country_of_origin: f.country_of_origin,
  };
}

function percentile(values: number[], q: number): number {
  if (values.length === 0) return 0;
  const sorted = [...values].sort((a, b) => a - b);
  const idx = Math.min(sorted.length - 1, Math.floor(q * (sorted.length - 1)));
  return sorted[idx] ?? 0;
}

// ─── Cross-pair runner ──────────────────────────────────────────────────────

async function cmdCrossPair(args: Args): Promise<void> {
  const apiKey = process.env.GOOGLE_API_KEY;
  if (!apiKey) {
    throw new Error("GOOGLE_API_KEY not set — cross-pair runs real verifies.");
  }
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

  // Load GTs (skip dotfiles like .country-corrections-*.json).
  const truthFiles = (await readdir(truthsDir))
    .filter((f) => f.endsWith(".json") && !f.startsWith("."))
    .sort();
  const limit = args.limit > 0 ? args.limit : truthFiles.length;
  const slice = truthFiles.slice(0, limit);

  // Build the task list — two per image (correct + wrong).
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
    // Image extension can be .png (synthetic / degraded) or .jpg (ai).
    const candidatePngOrJpg = [`${stem}.png`, `${stem}.jpg`, `${stem}.jpeg`]
      .map((f) => join(labelsDir, f))
      .find((p) => existsSync(p));
    if (!candidatePngOrJpg) continue;
    const compliant = isGtCompliant(gt);
    tasks.push({
      id: stem,
      imagePath: candidatePngOrJpg,
      condition: "correct",
      gtPath: join(truthsDir, name),
      expectedVerdict: compliant ? "pass" : "fail",
      govWarningCase: gt.gov_warning_case ?? null,
    });
    if (existsSync(join(wrongDir, name))) {
      tasks.push({
        id: stem,
        imagePath: candidatePngOrJpg,
        condition: "wrong",
        gtPath: join(wrongDir, name),
        // 5 fields mutated; matcher should fail or at minimum route to review.
        expectedVerdict: "fail",
        govWarningCase: gt.gov_warning_case ?? null,
      });
    }
  }

  if (!args.json) {
    // eslint-disable-next-line no-console
    console.log(
      `cross-pair: corpus=${args.corpus} images=${slice.length} tasks=${tasks.length} concurrency=${args.concurrency}`,
    );
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
      try {
        const gtText = await readFile(task.gtPath, "utf8");
        const gt = JSON.parse(gtText) as GtFile;
        const declared = toDeclared(gt);
        if (!declared) {
          records.push({
            image: basename(task.imagePath),
            condition: task.condition,
            expected: task.expectedVerdict,
            actual: "error",
            imageQuality: "skipped",
            timings: null,
            elapsedMs: 0,
            error: "GT missing required country_of_origin",
            govWarningCase: task.govWarningCase,
          });
          continue;
        }
        const validated = DeclaredFieldsSchema.safeParse(declared);
        if (!validated.success) {
          records.push({
            image: basename(task.imagePath),
            condition: task.condition,
            expected: task.expectedVerdict,
            actual: "error",
            imageQuality: "schema",
            timings: null,
            elapsedMs: 0,
            error: validated.error.issues[0]?.message ?? "schema error",
            govWarningCase: task.govWarningCase,
          });
          continue;
        }
        const image = await readFile(task.imagePath);
        const r = await verifyLabel(image, validated.data);
        records.push({
          image: basename(task.imagePath),
          condition: task.condition,
          expected: task.expectedVerdict,
          actual: r.verdict,
          imageQuality: r.imageQuality,
          timings: r.timings,
          elapsedMs: Date.now() - t0,
          govWarningCase: task.govWarningCase,
        });
      } catch (err) {
        records.push({
          image: basename(task.imagePath),
          condition: task.condition,
          expected: task.expectedVerdict,
          actual: "error",
          imageQuality: "error",
          timings: null,
          elapsedMs: Date.now() - t0,
          error: (err as Error).message,
          govWarningCase: task.govWarningCase,
        });
      }
      if (!args.json) {
        const r = records[records.length - 1]!;
        // eslint-disable-next-line no-console
        console.log(
          `  [${records.length}/${tasks.length}] ${r.image} (${r.condition}): expected=${r.expected} actual=${r.actual} ${r.elapsedMs}ms`,
        );
      }
    }
  }
  await Promise.all(Array.from({ length: Math.max(1, args.concurrency) }, () => pump()));

  // ─── Summarize ──────────────────────────────────────────────────────────
  const correct = records.filter((r) => r.condition === "correct" && r.actual !== "error");
  const wrong = records.filter((r) => r.condition === "wrong" && r.actual !== "error");
  const passOnCorrect = correct.filter((r) => r.actual === r.expected).length;
  const failOrReviewOnWrong = wrong.filter(
    (r) => r.actual === "fail" || r.actual === "review",
  ).length;
  const totals = records.filter((r) => r.timings !== null).map((r) => r.timings!.total);
  const visions = records.filter((r) => r.timings !== null).map((r) => r.timings!.vision);

  // by-category breakdown using gov_warning_case (groups null / unknown).
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
  // eslint-disable-next-line no-console
  console.log(`\nCross-pair summary:`);
  // eslint-disable-next-line no-console
  console.log(`  pass-rate on CORRECT GT:        ${(summary.passRateOnCorrect * 100).toFixed(1)}% (${passOnCorrect}/${correct.length})`);
  // eslint-disable-next-line no-console
  console.log(`  fail/review-rate on WRONG GT:   ${(summary.failOrReviewRateOnWrong * 100).toFixed(1)}% (${failOrReviewOnWrong}/${wrong.length})`);
  // eslint-disable-next-line no-console
  console.log(`  errors:                         ${summary.errors}`);
  // eslint-disable-next-line no-console
  console.log(`  latency P50/P95 (total):        ${summary.latencyMs.p50_total} / ${summary.latencyMs.p95_total} ms`);
  // eslint-disable-next-line no-console
  console.log(`  latency P50/P95 (vision):       ${summary.latencyMs.p50_vision} / ${summary.latencyMs.p95_vision} ms`);
  if (Object.keys(summary.byCase).length > 1) {
    // eslint-disable-next-line no-console
    console.log(`\n  By gov_warning_case:`);
    for (const [k, v] of Object.entries(summary.byCase)) {
      const pcCorrect = v.passRateOnCorrect === null ? "—" : `${(v.passRateOnCorrect * 100).toFixed(0)}%`;
      const pcWrong = v.failOrReviewRateOnWrong === null ? "—" : `${(v.failOrReviewRateOnWrong * 100).toFixed(0)}%`;
      // eslint-disable-next-line no-console
      console.log(`    ${k.padEnd(14)} correct→pass ${pcCorrect.padStart(5)} (n=${v.n_correct})   wrong→fail/review ${pcWrong.padStart(5)} (n=${v.n_wrong})`);
    }
  }
  if (args.out) {
    // eslint-disable-next-line no-console
    console.log(`\n  Wrote ${args.out}`);
  }
}

// ─── Entry ──────────────────────────────────────────────────────────────────

async function main(): Promise<void> {
  const args = parseArgs(process.argv);
  if (args.help || !args.command) {
    printHelp();
    return;
  }
  try {
    switch (args.command) {
      case "cross-pair":
        await cmdCrossPair(args);
        break;
      default:
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
