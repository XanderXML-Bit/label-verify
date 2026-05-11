// Benchmark runner. Per APPROACH.md §2.1, scope is exactly four contenders:
//   T1 Tesseract OCR baseline (text-only — extracts what it can find)
//   T4 GPT-4o-mini Vision
//   T6 Gemini 2.0 Flash Vision
//   C1 OCR + Vision combined (T1 + T6)
//
// This file iterates: for each technique × each labeled image, runs the
// extractor, scores per-field against ground truth, then aggregates with
// the helpers in ./score.ts (Wilson 95% CI, McNemar's test, stratified
// reporting, OOD column, FN rate on Gov Warning).
//
// The corpus comes from test-data/labels/ and test-data/ground-truth/ —
// see docs/CODEX-HANDOFF.md for the image-generation specification.

import { readFile, readdir, writeFile, mkdir } from "node:fs/promises";
import { join, dirname } from "node:path";
import {
  type PerItemOutcome,
  type PerItemWarningOutcome,
  summarize,
  stratify,
  mcNemar,
  falseNegativeRate,
  partitionOod,
} from "./score";

const SMOKE = process.argv.includes("--smoke");
const ROOT = process.cwd();
const LABELS_DIR = join(ROOT, "test-data", "labels");
const TRUTH_DIR = join(ROOT, "test-data", "ground-truth");
const RESULTS_DIR = join(ROOT, "benchmarks", "results");

interface GroundTruthFile {
  id: string;
  source: "synthetic" | "degraded" | "real";
  image: string;
  degradations?: string[];
  beverage_type?: "beer" | "wine" | "spirits" | "fortified_wine" | "rtd";
  label_face?: "front" | "back" | "neck";
  fields: Record<string, unknown>;
  /** Gov-Warning compliance taxonomy tag, e.g. "T1", "C2", "B3", "X1". */
  gov_warning_case?: string;
  notes?: string;
}

async function main(): Promise<void> {
  const truthFiles = await listTruthFiles();
  if (truthFiles.length === 0) {
    console.warn(
      "[bench] No ground-truth files found in test-data/ground-truth/.\n" +
        "        Codex needs to produce the corpus first — see docs/CODEX-HANDOFF.md.",
    );
    process.exit(1);
  }

  // Smoke-test mode: only the first 20 images.
  const subset = SMOKE ? truthFiles.slice(0, 20) : truthFiles;
  console.warn(
    `[bench] mode=${SMOKE ? "smoke" : "full"}  corpus=${subset.length}/${truthFiles.length}`,
  );

  // ─── Per-technique outcome accumulation ──────────────────────────────────
  // For Phase 2 this is wired against the actual extractor implementations
  // (lib/vision/gemini.ts, lib/ocr/tesseract.ts, etc.). For Phase 1 the
  // shape is defined and the runner is gated until the corpus exists.
  const perTechnique: Record<string, PerItemOutcome[]> = {
    T1: [],
    T4: [],
    T6: [],
    C1: [],
  };
  const govWarningOutcomes: Record<string, PerItemWarningOutcome[]> = {
    T1: [],
    T4: [],
    T6: [],
    C1: [],
  };

  // Per-image, per-technique extraction would happen here.
  // for (const truth of subset) { ... }

  // ─── Aggregation ─────────────────────────────────────────────────────────
  const summary = {
    runAt: new Date().toISOString(),
    mode: SMOKE ? "smoke" : "full",
    corpusSize: subset.length,
    perTechniqueOverall: Object.fromEntries(
      Object.entries(perTechnique).map(([t, outs]) => [t, summarize(outs)]),
    ),
    stratified: Object.fromEntries(
      Object.entries(perTechnique).map(([t, outs]) => [
        t,
        stratify(outs, ["beverage_type", "condition"]),
      ]),
    ),
    pairwiseMcNemar: pairwise(perTechnique),
    govWarningFnRate: Object.fromEntries(
      Object.entries(govWarningOutcomes).map(([t, w]) => [t, falseNegativeRate(w)]),
    ),
    ood: Object.fromEntries(
      Object.entries(perTechnique).map(([t, outs]) => {
        const split = partitionOod(outs);
        return [t, { id: summarize(split.id), ood: summarize(split.ood) }];
      }),
    ),
  };

  // ─── Persist ─────────────────────────────────────────────────────────────
  await mkdir(RESULTS_DIR, { recursive: true });
  const stamp = summary.runAt.replace(/[:.]/g, "-");
  const jsonPath = join(RESULTS_DIR, `${stamp}.json`);
  const mdPath = join(RESULTS_DIR, `${stamp}.md`);
  await writeFile(jsonPath, JSON.stringify(summary, null, 2));
  await writeFile(mdPath, renderMarkdown(summary));
  console.warn(`[bench] wrote ${jsonPath}`);
  console.warn(`[bench] wrote ${mdPath}`);
}

async function listTruthFiles(): Promise<GroundTruthFile[]> {
  let entries: string[];
  try {
    entries = await readdir(TRUTH_DIR);
  } catch {
    return [];
  }
  const out: GroundTruthFile[] = [];
  for (const e of entries.filter((x) => x.endsWith(".json"))) {
    const path = join(TRUTH_DIR, e);
    const text = await readFile(path, "utf8");
    out.push(JSON.parse(text) as GroundTruthFile);
  }
  return out.sort((a, b) => a.id.localeCompare(b.id));
}

function pairwise(
  perTechnique: Record<string, PerItemOutcome[]>,
): Record<string, ReturnType<typeof mcNemar>> {
  const techs = Object.keys(perTechnique);
  const out: Record<string, ReturnType<typeof mcNemar>> = {};
  for (let i = 0; i < techs.length; i++) {
    for (let j = i + 1; j < techs.length; j++) {
      const a = techs[i]!;
      const b = techs[j]!;
      out[`${a}_vs_${b}`] = mcNemar(perTechnique[a]!, perTechnique[b]!);
    }
  }
  return out;
}

function renderMarkdown(summary: Record<string, unknown>): string {
  return [
    `# Benchmark Run — ${summary.runAt}`,
    "",
    `Mode: \`${summary.mode}\`. Corpus size: ${summary.corpusSize}.`,
    "",
    "## Overall accuracy (Wilson 95% CI)",
    "",
    "| Technique | Acc | CI |",
    "|-----------|-----|----|",
    ...Object.entries(summary.perTechniqueOverall as Record<string, { acc: number; ciLo: number; ciHi: number; n: number }>).map(
      ([t, s]) =>
        `| ${t} | ${(s.acc * 100).toFixed(1)}% (n=${s.n}) | [${(s.ciLo * 100).toFixed(1)}, ${(s.ciHi * 100).toFixed(1)}] |`,
    ),
    "",
    "_See `<timestamp>.json` for full stratified + pairwise McNemar + Gov-Warning FN-rate tables._",
    "",
  ].join("\n");
}

void dirname; // keep import lint-clean

main().catch((err: unknown) => {
  console.error(err);
  process.exit(1);
});
