// Per-image Markdown report generator for the cross-pair bench.
//
// Consumes the bench's `CallRecord`-shaped records (after the wave-13
// bucket-classification pass) and emits an operator-facing report
// where the highest-priority findings (errors, false positives,
// false fails) appear at the top, and the large happy-path buckets
// are summarized into a single table at the bottom so the report
// stays readable.
//
// Pure function — no I/O. The bench CLI is responsible for writing
// the returned string to disk.

import type { Bucket } from "./bench-classify";
import { bucketLabel } from "./bench-classify";
import type { DeclaredFields, VerifyTimings } from "./types";

export interface PerImageRecord {
  image: string;
  condition: "correct" | "wrong";
  expected: "pass" | "fail" | "review" | "error";
  actual: "pass" | "fail" | "review" | "error";
  bucket: Bucket;
  imageQuality: string;
  govWarningCase: string | null;
  elapsedMs: number;
  timings?: VerifyTimings | null;
  error?: string;
  /** Application data bound to the task (after Zod validation). May
   *  be null when the task errored before validation completed. */
  declared: DeclaredFields | null;
  /** Path of the ground-truth file used for this task (correct or
   *  perturbed-wrong directory). Helps the operator trace a
   *  surprising verdict back to the exact GT row. */
  gtPath: string;
}

export interface PerImageReportInput {
  corpus: string;
  runAt: string;
  /** Short SHA of the commit the bench ran against, or null when
   *  the bench was invoked outside a git checkout. */
  commit: string | null;
  summary: {
    images: number;
    tasks: number;
    completed: number;
    errors: number;
    passRateOnCorrect: number;
    failOrReviewRateOnWrong: number;
  };
  records: readonly PerImageRecord[];
}

const HEADLINE_BUCKETS: readonly Bucket[] = [
  "error-on-correct",
  "error-on-wrong",
  "false-pass-on-wrong",
  "false-pass-on-correct",
  "false-fail",
  "review-on-correct",
  "review-on-wrong",
] as const;

const SECTION_TITLE: Record<Bucket, string> = {
  "error-on-correct": "Errors (correct GT)",
  "error-on-wrong": "Errors (wrong GT)",
  "false-pass-on-wrong": "False positives (regulator-dangerous)",
  "false-pass-on-correct": "False positives (correct GT said fail, verifier passed)",
  "false-fail": "False fails / false negatives (compliant labels rejected)",
  "review-on-correct": "Reviews on correct GT (operator friction)",
  "review-on-wrong": "Reviews on wrong GT (REVIEW deferral safety net firing)",
  "true-pass": "True pass",
  "true-fail": "True fail",
  "true-reject": "True reject",
};

export function renderPerImageMarkdown(input: PerImageReportInput): string {
  const { corpus, runAt, commit, summary, records } = input;
  const lines: string[] = [];
  lines.push(`# Cross-pair bench — per-image trace`);
  lines.push(``);
  lines.push(`- corpus: \`${corpus}\``);
  lines.push(`- runAt: ${runAt}`);
  if (commit) lines.push(`- commit: \`${commit}\``);
  lines.push(`- ${summary.images} images / ${summary.tasks} tasks / ${summary.completed} completed`);
  lines.push(`- pass-rate on correct: ${(summary.passRateOnCorrect * 100).toFixed(1)}%`);
  lines.push(`- fail-or-review rate on wrong: ${(summary.failOrReviewRateOnWrong * 100).toFixed(1)}%`);
  lines.push(`- errors: ${summary.errors}`);
  lines.push(``);

  if (records.length === 0) {
    lines.push(`No tasks completed.`);
    lines.push(``);
    return lines.join("\n");
  }

  // Bucket records once so we render each section in a single pass.
  const byBucket = new Map<Bucket, PerImageRecord[]>();
  for (const r of records) {
    const arr = byBucket.get(r.bucket) ?? [];
    arr.push(r);
    byBucket.set(r.bucket, arr);
  }

  // Headline sections — every record gets its own block, since these
  // are the buckets the operator needs to investigate row-by-row.
  for (const bucket of HEADLINE_BUCKETS) {
    const rows = byBucket.get(bucket) ?? [];
    if (rows.length === 0) continue;
    lines.push(`## ${SECTION_TITLE[bucket]}`);
    lines.push(``);
    lines.push(`> ${bucketLabel(bucket)} — ${rows.length} task${rows.length === 1 ? "" : "s"}.`);
    lines.push(``);
    for (const r of rows) {
      lines.push(renderRecordBlock(r));
      lines.push(``);
    }
  }

  // Happy-path summary — large buckets get a one-line count rather
  // than per-record listing. We sample 3 random records from each
  // for a sanity check so the operator can spot-check the happy path.
  lines.push(`## Happy path (summary)`);
  lines.push(``);
  const happy = ["true-pass", "true-fail", "true-reject"] as const;
  // Labels for the happy-path roll-up. Narrowing `happy` to its own
  // tuple type keeps this table tight to the buckets we render here
  // — not the full 9-bucket taxonomy (the other 6 already each got
  // their own section above).
  const happyLabels: Record<(typeof happy)[number], string> = {
    "true-pass": "True passes",
    "true-fail": "True fails",
    "true-reject": "True rejects",
  };
  for (const bucket of happy) {
    const rows = byBucket.get(bucket) ?? [];
    if (rows.length === 0) continue;
    lines.push(`- **${happyLabels[bucket]}: ${rows.length}** — sample: ${sampleNames(rows, 3)}`);
  }
  lines.push(``);

  return lines.join("\n");
}

function renderRecordBlock(r: PerImageRecord): string {
  const lines: string[] = [];
  lines.push(`### \`${r.image}\` (${r.condition} GT)`);
  lines.push(``);
  lines.push(`- expected: \`${r.expected}\` · actual: \`${r.actual}\` · bucket: \`${r.bucket}\``);
  lines.push(`- gov_warning_case: \`${r.govWarningCase ?? "—"}\` · imageQuality: \`${r.imageQuality}\``);
  lines.push(`- elapsedMs: ${r.elapsedMs}` + (r.timings ? ` (vision ${r.timings.vision} ms, ocr ${r.timings.ocr} ms)` : ""));
  lines.push(`- gtPath: \`${r.gtPath}\``);
  if (r.error) {
    lines.push(`- **error:** \`${escapeBackticks(r.error)}\``);
  }
  if (r.declared) {
    lines.push(`- declared:`);
    lines.push("  ```json");
    lines.push("  " + JSON.stringify(r.declared, null, 2).split("\n").join("\n  "));
    lines.push("  ```");
  } else {
    lines.push(`- declared: \`null\` (task errored before validation)`);
  }
  return lines.join("\n");
}

function sampleNames(rows: readonly PerImageRecord[], n: number): string {
  if (rows.length <= n) return rows.map((r) => `\`${r.image}\``).join(", ");
  // Stable "sample": first, middle, last. Avoids non-determinism in
  // the snapshot tests while still spot-checking three different
  // points in the input list.
  const picks = [rows[0]!, rows[Math.floor(rows.length / 2)]!, rows[rows.length - 1]!];
  return picks.map((r) => `\`${r.image}\``).join(", ");
}

function escapeBackticks(s: string): string {
  return s.replace(/`/g, "'");
}
