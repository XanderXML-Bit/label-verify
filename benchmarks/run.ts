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
import { existsSync, readFileSync } from "node:fs";
import { basename, join } from "node:path";

// ─── .env.local loader (no extra deps) ──────────────────────────────────────
// The bench runs via `tsx benchmarks/run.ts`, which does NOT auto-load
// Next.js's `.env.local`. Without this, every vision technique skips with
// "API key missing" even when the keys are committed to .env.local. Same
// pattern as scripts/cross-validate-ai-corpus.ts.
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
    // Override empty-string parent-shell exports (a common Windows/WSL
    // quirk where the shell ships ANTHROPIC_API_KEY="" or similar) so the
    // .env.local value wins. Only skip when the parent already has a
    // non-empty value, which is the legitimate "operator overrode it" case.
    const existing = process.env[k];
    if (existing === undefined || existing === "") process.env[k] = v;
  }
}
loadDotenv(".env.local");
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
import { BUILTIN_TECHNIQUES, BAKEOFF_TECHNIQUES, findTechnique, type TechniqueRunner } from "./techniques";
import { ROUTINE_IDS, selectRoutine } from "./routine";
import { scoreImage, type GroundTruth } from "./scorer";
import { preprocessImage } from "../src/lib/preprocess";
import type { ExtractorCost } from "../src/lib/vision/types";

// ─── CLI argument parsing ───────────────────────────────────────────────────

interface CliArgs {
  /** First-N slice of the corpus, 1 trial. Backward-compat legacy mode. */
  smoke: boolean;
  /**
   * Curated 15-label subset for routine / CI runs (see benchmarks/routine.ts).
   * Cost-conscious "is anything obviously broken?" signal — the full corpus
   * stays reserved for the formal bake-off (`--bake-off` without `--routine`).
   */
  routine: boolean;
  corpus: string;
  techniques: string[];
  bakeoff: boolean;
  /**
   * Explicit trial count override. When unset, defaults are:
   *   - --smoke / --routine → 1 trial
   *   - otherwise           → 3 trials (FULL)
   * Useful for a "fast full-corpus pass" where you want every image in
   * the corpus but only one measurement each.
   */
  trials?: number;
}

function parseArgs(argv: string[]): CliArgs {
  const out: CliArgs = {
    smoke: false,
    routine: false,
    corpus: "test-data",
    techniques: [],
    bakeoff: false,
  };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === "--smoke") out.smoke = true;
    else if (a === "--routine") out.routine = true;
    else if (a === "--bake-off" || a === "--bakeoff") out.bakeoff = true;
    else if (a === "--corpus") {
      const v = argv[++i];
      if (v) out.corpus = v;
    } else if (a === "--technique") {
      const v = argv[++i];
      if (v) out.techniques.push(v);
    } else if (a === "--trials") {
      const v = argv[++i];
      if (v) {
        const n = Number(v);
        if (Number.isFinite(n) && n > 0) out.trials = n;
      }
    }
  }
  // --smoke and --routine are mutually exclusive: they answer different
  // questions (legacy first-N slice vs. curated coverage subset) and combining
  // them would silently pick one. Fail loud so the caller updates their
  // invocation rather than ship a confusing run.
  if (out.smoke && out.routine) {
    throw new Error(
      "[bench] --smoke and --routine are mutually exclusive. " +
        "Use --routine for the curated 15-label CI subset; --smoke is the " +
        "legacy first-20 slice kept for backward compatibility.",
    );
  }
  return out;
}

const ARGS = parseArgs(process.argv.slice(2));
const ROOT = process.cwd();
const RESULTS_DIR = join(ROOT, "benchmarks", "results");
const TRIALS_FULL = 3;
const TRIALS_SMOKE = 1;
/** --routine matches --smoke: one trial per label. Routine is for fast feedback,
 *  not latency-variance estimation; if you need that, run the full bake-off. */
const TRIALS_ROUTINE = 1;
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
  /** Per-call cost from the extractor. `undefined` for T1 (local OCR). */
  cost?: ExtractorCost;
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

  for (let imgIdx = 0; imgIdx < truths.length; imgIdx++) {
    const gt = truths[imgIdx]!;
    const imgStart = performance.now();
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
        trialsLog.push({
          imageId: gt.id,
          trial: t,
          latencyMs,
          ok: true,
          ...(extracted.cost ? { cost: extracted.cost } : {}),
        });

        // Score only the first successful trial. Additional trials are kept
        // for latency variance only (per APPROACH.md §5 step 3).
        if (!scored) {
          const result = await scoreImage(gt, extracted.fields, {
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
    // Per-image progress: prints a single line per image so a long-running
    // technique (T4, T6c, T7, T12) doesn't look hung. Stays on console.warn
    // so it interleaves correctly with summary lines through tee + 2>&1.
    const imgElapsed = Math.round(performance.now() - imgStart);
    console.warn(
      `[bench] ${id} [${imgIdx + 1}/${truths.length}] ${gt.id}: ${imgElapsed}ms`,
    );
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
  /** Token + USD accounting aggregated across trials. */
  economics: {
    /** Mean tokens-in per call across successful trials. */
    inputTokensPerCall: number;
    outputTokensPerCall: number;
    /** Mean USD per call. */
    costUsdPerCall: number;
    /** Extrapolated USD to verify 1k labels at the observed per-call cost. */
    costUsdPer1k: number;
    /** Total USD spent during this run (signal for the reviewer). */
    totalCostUsd: number;
    /** accuracy / dollar — useful for ranking the cost-effective frontier. */
    accuracyPerDollar: number | null;
    /** accuracy / second — useful for ranking the speed-effective frontier. */
    accuracyPerSecond: number | null;
  };
}

interface BenchmarkSummary {
  runAt: string;
  /**
   * "smoke" = legacy first-20 slice (1 trial).
   * "routine" = curated 15-label coverage subset (1 trial) — see
   *             benchmarks/routine.ts and docs/MODEL-SELECTION.md §3.5.
   * "full" = full corpus, 3 trials — formal bake-off mode.
   */
  mode: "smoke" | "routine" | "full";
  corpusRoot: string;
  corpusSize: number;
  trialsPerImage: number;
  techniques: TechniqueSummary[];
  pairwiseMcNemar: Record<string, McNemarResult>;
}

function summarizeRun(run: TechniqueRun): TechniqueSummary {
  const overall = summarize(run.outcomes);
  const latency = latencyStats(run.trials);
  const okTrials = run.trials.filter((t) => t.ok);
  const withCost = okTrials.filter((t): t is TrialRecord & { cost: ExtractorCost } =>
    t.cost !== undefined,
  );
  const totalInputTokens = withCost.reduce((s, t) => s + t.cost.inputTokens, 0);
  const totalOutputTokens = withCost.reduce((s, t) => s + t.cost.outputTokens, 0);
  const totalCostUsd = withCost.reduce((s, t) => s + t.cost.costUsd, 0);
  const n = withCost.length;
  const costPerCall = n > 0 ? totalCostUsd / n : 0;
  // accuracyPerDollar / accuracyPerSecond return null when there's no
  // signal (T1 has no $; skipped runs have no acc) — markdown renders "—".
  const accuracyPerDollar = costPerCall > 0 ? overall.acc / costPerCall : null;
  const meanLatencySec = latency.n > 0 ? latency.mean / 1000 : 0;
  const accuracyPerSecond = meanLatencySec > 0 ? overall.acc / meanLatencySec : null;
  return {
    id: run.id,
    skipped: run.skipped ?? null,
    overall,
    stratified: stratify(run.outcomes, ["beverage_type", "condition"]),
    govWarningFnRate: falseNegativeRate(run.warningOutcomes),
    ood: (() => {
      const split = partitionOod(run.outcomes);
      return { id: summarize(split.id), ood: summarize(split.ood) };
    })(),
    latencyMs: latency,
    trialCount: run.trials.length,
    imageFailureCount: run.failures,
    economics: {
      inputTokensPerCall: n > 0 ? totalInputTokens / n : 0,
      outputTokensPerCall: n > 0 ? totalOutputTokens / n : 0,
      costUsdPerCall: costPerCall,
      costUsdPer1k: costPerCall * 1000,
      totalCostUsd,
      accuracyPerDollar,
      accuracyPerSecond,
    },
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

  // ─── Economics + Pareto frontier ────────────────────────────────────────
  lines.push(
    "",
    "## Economics (cost + acc-per-\\$ + acc-per-second)",
    "",
    "Per-call token + USD figures aggregated across successful trials. `cost/1k` extrapolates the per-call cost to 1,000 labels (the prototype's batch-day target).",
    "",
  );
  lines.push("| Technique | In tok / call | Out tok / call | USD / call | USD / 1k labels | Acc / \\$ | Acc / sec |");
  lines.push("|-----------|---------------|----------------|------------|------------------|----------|-----------|");
  for (const t of summary.techniques) {
    if (t.skipped) {
      lines.push(`| ${t.id} | — | — | — | — | — | — |`);
      continue;
    }
    const e = t.economics;
    const ind = e.inputTokensPerCall > 0 ? e.inputTokensPerCall.toFixed(0) : "—";
    const out = e.outputTokensPerCall > 0 ? e.outputTokensPerCall.toFixed(0) : "—";
    const usdCall = e.costUsdPerCall > 0 ? `$${e.costUsdPerCall.toFixed(5)}` : "$0";
    const usd1k = e.costUsdPer1k > 0 ? `$${e.costUsdPer1k.toFixed(2)}` : "$0";
    const apd = e.accuracyPerDollar !== null
      ? e.accuracyPerDollar.toFixed(2)
      : (e.costUsdPerCall === 0 ? "∞ (free)" : "—");
    const aps = e.accuracyPerSecond !== null ? e.accuracyPerSecond.toFixed(3) : "—";
    lines.push(
      `| ${t.id} | ${ind} | ${out} | ${usdCall} | ${usd1k} | ${apd} | ${aps} |`,
    );
  }

  // Pareto frontier: any technique not strictly dominated by another on
  // (accuracy ↑, latency ↓, cost ↓). Reviewer-readable.
  const eligible = summary.techniques.filter(
    (t) => !t.skipped && t.overall.n > 0 && t.latencyMs.n > 0,
  );
  const dominated = new Set<string>();
  for (const a of eligible) {
    for (const b of eligible) {
      if (a.id === b.id) continue;
      const bDominatesA =
        b.overall.acc >= a.overall.acc &&
        b.latencyMs.mean <= a.latencyMs.mean &&
        b.economics.costUsdPerCall <= a.economics.costUsdPerCall &&
        (b.overall.acc > a.overall.acc ||
          b.latencyMs.mean < a.latencyMs.mean ||
          b.economics.costUsdPerCall < a.economics.costUsdPerCall);
      if (bDominatesA) dominated.add(a.id);
    }
  }
  const pareto = eligible.filter((t) => !dominated.has(t.id));
  if (pareto.length > 0) {
    lines.push(
      "",
      "## Pareto frontier (accuracy ↑ · latency ↓ · cost ↓)",
      "",
      "Techniques not strictly dominated by any other on the three-axis frontier. A reviewer picking the deployed model should choose one from this list — others are inferior on every axis they care about.",
      "",
      "| Technique | Acc | Mean latency (ms) | USD / 1k labels |",
      "|-----------|-----|--------------------|------------------|",
    );
    for (const t of pareto) {
      lines.push(
        `| **${t.id}** | ${fmtPct(t.overall)} | ${Math.round(t.latencyMs.mean)} | ${t.economics.costUsdPer1k > 0 ? `$${t.economics.costUsdPer1k.toFixed(2)}` : "$0"} |`,
      );
    }
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
  // Corpus selection precedence:
  //   --routine  → curated 15-label coverage subset (CI / fast feedback)
  //   --smoke    → legacy first-20 slice (kept for backward compatibility)
  //   default    → full corpus (formal bake-off territory)
  // --smoke and --routine are forbidden together at parse time.
  let subset: GroundTruth[];
  let mode: BenchmarkSummary["mode"];
  let trials: number;
  if (ARGS.routine) {
    subset = selectRoutine(truths);
    mode = "routine";
    trials = TRIALS_ROUTINE;
    // Loud banner so the operator (and CI logs) can confirm the cost-conscious
    // mode is engaged before any vision-extractor USD starts ticking.
    console.warn(
      `[bench] routine mode — ${ROUTINE_IDS.length} curated labels, ` +
        `${trials} trial${trials === 1 ? "" : "s"} per label. ` +
        `Full corpus is reserved for the formal bake-off (drop --routine to run it).`,
    );
  } else if (ARGS.smoke) {
    subset = truths.slice(0, 20);
    mode = "smoke";
    trials = TRIALS_SMOKE;
  } else {
    subset = truths;
    mode = "full";
    trials = TRIALS_FULL;
  }

  // CLI override: --trials N wins over the mode default. Useful for
  // "fast full-corpus pass" where you want every image but only one
  // measurement (cuts a 140-image bench from ~50 min to ~17 min).
  if (typeof ARGS.trials === "number") {
    trials = ARGS.trials;
    console.warn(`[bench] trials per image overridden via --trials: ${trials}`);
  }

  const selectedIds =
    ARGS.techniques.length > 0
      ? ARGS.techniques
      : ARGS.bakeoff
        ? [...BAKEOFF_TECHNIQUES]
        : BUILTIN_TECHNIQUES.filter((t) =>
            ["T1", "T4", "T6", "C1"].includes(t.id),
          ).map((t) => t.id);

  console.warn(
    `[bench] mode=${mode}  corpus=${subset.length}/${truths.length}  techniques=${selectedIds.join(",")}  trials=${trials}`,
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
    mode,
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
