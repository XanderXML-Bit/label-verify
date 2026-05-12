// Benchmark runner. Per APPROACH.md §2.1, scope is exactly four contenders:
//   T1 Tesseract OCR baseline (text-only — extracts what it can find)
//   T4 GPT-4o-mini Vision
//   T6 Gemini 2.0 Flash Vision
//   C1 OCR + Vision combined (T1 + T6)
//
// For each (technique, image) pair, the runner preprocesses, runs the
// extractor with a 60s per-image timeout, scores per-field via scorer.ts
// against ground truth, then aggregates with the helpers in ./score.ts
// (Wilson 95% CI, McNemar's test, stratified reporting, OOD column, FN rate
// on Gov Warning).
//
// The corpus comes from --corpus <dir>/labels + <dir>/ground-truth (default
// test-data; falls back to test-data-v2 if test-data is empty). See
// docs/CODEX-HANDOFF.md for the image-generation specification.

import { readFile, readdir, writeFile, mkdir, stat } from "node:fs/promises";
import { basename, join } from "node:path";
import {
  type AccuracyPoint,
  type PerItemOutcome,
  type PerItemWarningOutcome,
  type StratifiedTable,
  summarize,
  stratify,
  mcNemar,
  falseNegativeRate,
  partitionOod,
} from "./score";
import { BUILTIN_TECHNIQUES, findTechnique, type TechniqueRunner } from "./techniques";
import { scoreImage, type GroundTruth } from "./scorer";
import { preprocessImage } from "../src/lib/preprocess";

// ─── CLI argument parsing ───────────────────────────────────────────────────

interface CliArgs {
  smoke: boolean;
  corpus: string;
  techniques: string[];
}

function parseArgs(argv: string[]): CliArgs {
  const out: CliArgs = { smoke: false, corpus: "test-data", techniques: [] };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === "--smoke") out.smoke = true;
    else if (a === "--corpus") {
      const v = argv[++i];
      if (v) out.corpus = v;
    } else if (a === "--technique") {
      const v = argv[++i];
      if (v) out.techniques.push(v);
    }
  }
  return out;
}

const ARGS = parseArgs(process.argv.slice(2));
const ROOT = process.cwd();
const RESULTS_DIR = join(ROOT, "benchmarks", "results");
const TRIALS_FULL = 3;
const TRIALS_SMOKE = 1;
const PER_IMAGE_TIMEOUT_MS = 60_000;

// ─── Corpus loading ─────────────────────────────────────────────────────────

interface LoadedCorpus {
  truths: GroundTruth[];
  labelsDir: string;
  corpusRoot: string;
}

async function dirExists(p: string): Promise<boolean> {
  try {
    const s = await stat(p);
    return s.isDirectory();
  } catch {
    return false;
  }
}

async function loadCorpus(corpusArg: string): Promise<LoadedCorpus> {
  // Resolve the corpus root: explicit --corpus wins; otherwise fall back to
  // test-data-v2 if test-data is empty.
  const candidates: string[] = [join(ROOT, corpusArg)];
  if (corpusArg === "test-data") {
    candidates.push(join(ROOT, "test-data-v2"));
  }

  for (const root of candidates) {
    const truthsDir = join(root, "ground-truth");
    const labelsDir = join(root, "labels");
    if (!(await dirExists(truthsDir)) || !(await dirExists(labelsDir))) continue;
    const entries = (await readdir(truthsDir)).filter((e) => e.endsWith(".json"));
    if (entries.length === 0) continue;
    const truths: GroundTruth[] = [];
    for (const e of entries) {
      const text = await readFile(join(truthsDir, e), "utf8");
      truths.push(JSON.parse(text) as GroundTruth);
    }
    truths.sort((a, b) => a.id.localeCompare(b.id));
    return { truths, labelsDir, corpusRoot: root };
  }

  throw new Error(
    `[bench] No corpus found. Tried: ${candidates.join(", ")}. ` +
      `Pass --corpus <dir> pointing at a directory containing ./labels and ./ground-truth.`,
  );
}

// ─── Per-technique execution ────────────────────────────────────────────────

interface TrialRecord {
  imageId: string;
  trial: number;
  latencyMs: number;
  ok: boolean;
  error?: string;
}

interface TechniqueRun {
  id: string;
  outcomes: PerItemOutcome[];
  warningOutcomes: PerItemWarningOutcome[];
  trials: TrialRecord[];
  failures: number;
  skipped?: { reason: string };
}

async function withTimeout<T>(p: Promise<T>, ms: number, label: string): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | null = null;
  const timeout = new Promise<never>((_, reject) => {
    timer = setTimeout(
      () => reject(new Error(`[bench] timeout after ${ms}ms: ${label}`)),
      ms,
    );
  });
  try {
    return await Promise.race([p, timeout]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}

async function runTechnique(
  id: string,
  truths: GroundTruth[],
  labelsDir: string,
  trials: number,
): Promise<TechniqueRun> {
  const factory = findTechnique(id);
  if (!factory) {
    return {
      id,
      outcomes: [],
      warningOutcomes: [],
      trials: [],
      failures: 0,
      skipped: { reason: `Unknown technique id "${id}"` },
    };
  }

  let runner: TechniqueRunner;
  try {
    runner = await factory.build();
  } catch (err) {
    console.warn(`[bench] ${id}: skipped — ${(err as Error).message}`);
    return {
      id,
      outcomes: [],
      warningOutcomes: [],
      trials: [],
      failures: 0,
      skipped: { reason: (err as Error).message },
    };
  }

  const outcomes: PerItemOutcome[] = [];
  const warningOutcomes: PerItemWarningOutcome[] = [];
  const trialsLog: TrialRecord[] = [];
  let failures = 0;

  for (const gt of truths) {
    const imagePath = join(labelsDir, basename(gt.image));
    let imageBuf: Buffer;
    try {
      imageBuf = await readFile(imagePath);
    } catch (err) {
      console.warn(`[bench] ${id} ${gt.id}: cannot read ${imagePath} (${(err as Error).message})`);
      failures++;
      continue;
    }

    const pre = await preprocessImage(imageBuf);
    let scored = false;

    for (let t = 0; t < trials; t++) {
      const start = performance.now();
      try {
        const extracted = await withTimeout(
          runner.run(pre.buffer),
          PER_IMAGE_TIMEOUT_MS,
          `${id} ${gt.id} trial=${t}`,
        );
        const latencyMs = performance.now() - start;
        trialsLog.push({ imageId: gt.id, trial: t, latencyMs, ok: true });

        // Score only the first successful trial. Additional trials are kept
        // for latency variance only (per APPROACH.md §5 step 3).
        if (!scored) {
          const result = await scoreImage(gt, extracted, {
            width: pre.width,
            height: pre.height,
          });
          outcomes.push(...result.outcomes);
          warningOutcomes.push(result.warningOutcome);
          scored = true;
        }
      } catch (err) {
        const latencyMs = performance.now() - start;
        const msg = (err as Error).message;
        trialsLog.push({ imageId: gt.id, trial: t, latencyMs, ok: false, error: msg });
        failures++;
        console.warn(`[bench] ${id} ${gt.id} trial=${t}: ${msg}`);
      }
    }
  }

  return { id, outcomes, warningOutcomes, trials: trialsLog, failures };
}

// ─── Aggregation helpers ────────────────────────────────────────────────────

interface McNemarResult {
  statistic: number;
  pValue: number;
  b: number;
  c: number;
}

function pairwise(
  runs: TechniqueRun[],
): Record<string, McNemarResult> {
  const out: Record<string, McNemarResult> = {};
  const eligible = runs.filter((r) => !r.skipped && r.outcomes.length > 0);
  for (let i = 0; i < eligible.length; i++) {
    for (let j = i + 1; j < eligible.length; j++) {
      const a = eligible[i]!;
      const b = eligible[j]!;
      out[`${a.id}_vs_${b.id}`] = mcNemar(a.outcomes, b.outcomes);
    }
  }
  return out;
}

function latencyStats(trials: TrialRecord[]): {
  n: number;
  p50: number;
  p95: number;
  mean: number;
  failures: number;
} {
  const ok = trials.filter((t) => t.ok).map((t) => t.latencyMs);
  if (ok.length === 0) {
    return { n: 0, p50: 0, p95: 0, mean: 0, failures: trials.filter((t) => !t.ok).length };
  }
  const sorted = [...ok].sort((a, b) => a - b);
  const p = (q: number): number => {
    const i = Math.min(sorted.length - 1, Math.floor(q * (sorted.length - 1)));
    return sorted[i] ?? 0;
  };
  const mean = ok.reduce((s, x) => s + x, 0) / ok.length;
  return {
    n: ok.length,
    p50: p(0.5),
    p95: p(0.95),
    mean,
    failures: trials.filter((t) => !t.ok).length,
  };
}

// ─── Summary shape (machine-readable) ───────────────────────────────────────

interface TechniqueSummary {
  id: string;
  skipped: { reason: string } | null;
  overall: AccuracyPoint;
  stratified: StratifiedTable[];
  govWarningFnRate: AccuracyPoint;
  ood: { id: AccuracyPoint; ood: AccuracyPoint };
  latencyMs: ReturnType<typeof latencyStats>;
  trialCount: number;
  imageFailureCount: number;
}

interface BenchmarkSummary {
  runAt: string;
  mode: "smoke" | "full";
  corpusRoot: string;
  corpusSize: number;
  trialsPerImage: number;
  techniques: TechniqueSummary[];
  pairwiseMcNemar: Record<string, McNemarResult>;
}

function summarizeRun(run: TechniqueRun): TechniqueSummary {
  return {
    id: run.id,
    skipped: run.skipped ?? null,
    overall: summarize(run.outcomes),
    stratified: stratify(run.outcomes, ["beverage_type", "condition"]),
    govWarningFnRate: falseNegativeRate(run.warningOutcomes),
    ood: (() => {
      const split = partitionOod(run.outcomes);
      return { id: summarize(split.id), ood: summarize(split.ood) };
    })(),
    latencyMs: latencyStats(run.trials),
    trialCount: run.trials.length,
    imageFailureCount: run.failures,
  };
}

// ─── Markdown report ────────────────────────────────────────────────────────

function fmtPct(p: AccuracyPoint): string {
  if (p.n === 0) return "—";
  return `${(p.acc * 100).toFixed(1)}% (n=${p.n}) [${(p.ciLo * 100).toFixed(1)}, ${(p.ciHi * 100).toFixed(1)}]`;
}

function renderMarkdown(summary: BenchmarkSummary): string {
  const lines: string[] = [];
  lines.push(`# Benchmark Run — ${summary.runAt}`, "");
  lines.push(
    `Mode: \`${summary.mode}\`. Corpus: \`${summary.corpusRoot}\` (${summary.corpusSize} images). Trials per image: ${summary.trialsPerImage}.`,
    "",
  );

  // Overall accuracy
  lines.push("## Overall accuracy (Wilson 95% CI)", "");
  lines.push("| Technique | Acc | Gov-Warning FN-rate | Latency P50 / P95 (ms) | Failures |");
  lines.push("|-----------|-----|---------------------|------------------------|----------|");
  for (const t of summary.techniques) {
    if (t.skipped) {
      lines.push(`| ${t.id} | _skipped: ${t.skipped.reason}_ | — | — | — |`);
      continue;
    }
    const lat = t.latencyMs;
    lines.push(
      `| ${t.id} | ${fmtPct(t.overall)} | ${fmtPct(t.govWarningFnRate)} | ${Math.round(lat.p50)} / ${Math.round(lat.p95)} | ${t.imageFailureCount} |`,
    );
  }

  // OOD split
  lines.push("", "## OOD (real labels) vs ID (synthetic / degraded)", "");
  lines.push("| Technique | ID | OOD |");
  lines.push("|-----------|-----|-----|");
  for (const t of summary.techniques) {
    if (t.skipped) continue;
    lines.push(`| ${t.id} | ${fmtPct(t.ood.id)} | ${fmtPct(t.ood.ood)} |`);
  }

  // McNemar pairwise grid
  const pairKeys = Object.keys(summary.pairwiseMcNemar);
  if (pairKeys.length > 0) {
    lines.push("", "## Pairwise McNemar (paired technique-vs-technique)", "");
    lines.push("| Pair | Statistic | p-value | A-correct-B-wrong (b) | A-wrong-B-correct (c) |");
    lines.push("|------|-----------|---------|-----------------------|-----------------------|");
    for (const k of pairKeys) {
      const r = summary.pairwiseMcNemar[k]!;
      lines.push(
        `| ${k} | ${r.statistic.toFixed(3)} | ${r.pValue.toExponential(2)} | ${r.b} | ${r.c} |`,
      );
    }
  }

  lines.push(
    "",
    "_Full stratified (beverage_type × condition × field) tables in the sibling `.json` file._",
    "",
  );
  return lines.join("\n");
}

// ─── Main ───────────────────────────────────────────────────────────────────

async function main(): Promise<void> {
  const { truths, labelsDir, corpusRoot } = await loadCorpus(ARGS.corpus);
  const subset = ARGS.smoke ? truths.slice(0, 20) : truths;
  const trials = ARGS.smoke ? TRIALS_SMOKE : TRIALS_FULL;

  const selectedIds =
    ARGS.techniques.length > 0
      ? ARGS.techniques
      : BUILTIN_TECHNIQUES.map((t) => t.id);

  console.warn(
    `[bench] mode=${ARGS.smoke ? "smoke" : "full"}  corpus=${subset.length}/${truths.length}  techniques=${selectedIds.join(",")}  trials=${trials}`,
  );

  const techRuns: TechniqueRun[] = [];
  for (const id of selectedIds) {
    console.warn(`[bench] running ${id}…`);
    const tStart = performance.now();
    const run = await runTechnique(id, subset, labelsDir, trials);
    const elapsed = performance.now() - tStart;
    const summary = summarizeRun(run);
    if (run.skipped) {
      console.warn(`[bench] ${id}: SKIPPED (${run.skipped.reason})`);
    } else {
      console.warn(
        `[bench] ${id}: acc=${(summary.overall.acc * 100).toFixed(1)}% (n=${summary.overall.n})  ` +
          `lat-p50=${Math.round(summary.latencyMs.p50)}ms  failures=${summary.imageFailureCount}  ` +
          `elapsed=${Math.round(elapsed)}ms`,
      );
    }
    techRuns.push(run);
  }

  const summary: BenchmarkSummary = {
    runAt: new Date().toISOString(),
    mode: ARGS.smoke ? "smoke" : "full",
    corpusRoot,
    corpusSize: subset.length,
    trialsPerImage: trials,
    techniques: techRuns.map(summarizeRun),
    pairwiseMcNemar: pairwise(techRuns),
  };

  await mkdir(RESULTS_DIR, { recursive: true });
  const stamp = summary.runAt.replace(/[:.]/g, "-");
  const jsonPath = join(RESULTS_DIR, `${stamp}.json`);
  const mdPath = join(RESULTS_DIR, `${stamp}.md`);
  await writeFile(jsonPath, JSON.stringify(summary, null, 2));
  await writeFile(mdPath, renderMarkdown(summary));
  console.warn(`[bench] wrote ${jsonPath}`);
  console.warn(`[bench] wrote ${mdPath}`);
}

main()
  .then(() => {
    // Tesseract.js workers spawn child processes that keep the event loop
    // alive after main() resolves. Force an exit so the harness terminates
    // promptly under CI / shell pipes.
    process.exit(0);
  })
  .catch((err: unknown) => {
    console.error(err);
    process.exit(1);
  });
