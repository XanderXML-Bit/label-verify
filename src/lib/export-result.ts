// Export helpers for single + batch verification results.
//
// Two formats:
//   - JSON: full structured VerifyResponse with all comparator results,
//     subscores, confidence, timings, model identifiers. The format an
//     integrator wants for system-to-system handoff (e.g. dropping a
//     verified-batch report into TTB's internal queue).
//   - CSV: flat one-row-per-item summary. Slot-stable column shape so
//     spreadsheet imports never shift; missing/pending cells become "".
//
// Browser-only. The actual download happens client-side via a
// blob: URL → invisible <a>.click() → URL.revokeObjectURL — same
// pattern as the existing batch CSV export.

import type { VerifyResponse } from "@/lib/types";

export interface BatchRowLike {
  index: number;
  filename: string;
  status: "pending" | "running" | "done" | "error";
  result?: VerifyResponse;
  error?: string;
}

const CSV_HEADER = [
  "index",
  "filename",
  "verdict",
  "image_quality",
  "gov_warning_status",
  "gov_warning_text",
  "gov_warning_caps",
  "gov_warning_bold",
  "gov_warning_size",
  "brand_status",
  "brand_confidence",
  "class_status",
  "class_confidence",
  "abv_status",
  "abv_confidence",
  "net_contents_status",
  "net_contents_confidence",
  "producer_status",
  "producer_confidence",
  "country_status",
  "country_confidence",
  "review_reasons",
  "fallback_used",
  "model_id",
  "total_ms",
  "vision_ms",
  "preprocess_ms",
  "ocr_ms",
] as const;

// OWASP CSV-injection mitigation. Excel, LibreOffice, and Google Sheets
// auto-execute any cell whose first character is `=`, `+`, `-`, `@`, tab,
// or CR — turning a malicious filename like `=SUM(1+1).jpg` or a
// vision-model-derived review reason that happens to start with `-` into
// a working formula on open. Reviewer-facing CSV outputs flow user- and
// model-controlled strings through here (filename, reviewReasons, error,
// fallbackUsed, modelId). We neutralize the leading character with a
// single leading apostrophe — Excel hides it on render but the cell is
// no longer parsed as a formula. The apostrophe is added BEFORE the
// CSV quote/escape pass so the escape logic still sees a string literal.
const FORMULA_LEAD = /^[=+\-@\t\r]/;
function neutralizeFormula(s: string): string {
  return FORMULA_LEAD.test(s) ? `'${s}` : s;
}
function csvCell(v: unknown): string {
  if (v === null || v === undefined) return "";
  const s = neutralizeFormula(String(v));
  return `"${s.replace(/"/g, '""')}"`;
}

function rowForResult(index: number, filename: string, result: VerifyResponse): string[] {
  const f = result.fields;
  const sub = result.governmentWarning.subscores;
  return [
    String(index),
    filename,
    result.verdict,
    result.imageQuality,
    result.governmentWarning.status,
    sub.text.status,
    sub.caps.status,
    sub.bold.status,
    sub.size.status,
    f.brand_name.status,
    f.brand_name.confidence.toFixed(3),
    f.class_type.status,
    f.class_type.confidence.toFixed(3),
    f.abv_percent.status,
    f.abv_percent.confidence.toFixed(3),
    f.net_contents.status,
    f.net_contents.confidence.toFixed(3),
    f.producer.status,
    f.producer.confidence.toFixed(3),
    f.country_of_origin.status,
    f.country_of_origin.confidence.toFixed(3),
    (result.reviewReasons ?? []).join(" | "),
    result.fallbackUsed ?? "",
    result.modelId,
    String(Math.round(result.timings.total)),
    String(Math.round(result.timings.vision)),
    String(Math.round(result.timings.preprocess)),
    result.timings.ocr === null ? "" : String(Math.round(result.timings.ocr)),
  ];
}

function rowForUnfinished(index: number, filename: string, status: string, error?: string): string[] {
  return [
    String(index),
    filename,
    status,
    "",
    "",
    "",
    "",
    "",
    "",
    "",
    "",
    "",
    "",
    "",
    "",
    "",
    "",
    "",
    "",
    "",
    "",
    error ?? "",
    "",
    "",
    "",
    "",
    "",
    "",
  ];
}

/**
 * Build CSV text for a single verification result (one data row).
 * Trailing newline so a `cat result.csv >> aggregate.csv` cleanly
 * appends without manual fixup.
 */
export function singleResultToCsv(
  filename: string,
  result: VerifyResponse,
): string {
  const header = CSV_HEADER.join(",");
  const row = rowForResult(0, filename, result).map(csvCell).join(",");
  return `${header}\n${row}\n`;
}

/** Build CSV text for a batch (one row per item, ordered by index). */
export function batchToCsv(rows: BatchRowLike[]): string {
  const header = CSV_HEADER.join(",");
  const body = rows
    .map((r) =>
      r.status === "done" && r.result
        ? rowForResult(r.index, r.filename, r.result)
        : rowForUnfinished(r.index, r.filename, r.status, r.error),
    )
    .map((cells) => cells.map(csvCell).join(","))
    .join("\n");
  return `${header}\n${body}\n`;
}

/**
 * Wrap a VerifyResponse with submission metadata for the JSON export.
 * The integrator gets enough context to file a verified result into a
 * downstream system without losing what we asserted.
 */
export interface SingleJsonExport {
  schema: "labelverify.v1.single";
  exportedAt: string;
  filename: string;
  result: VerifyResponse;
  /**
   * Wave-34 audit-trail fields (#22 + #29). Stamp the JSON export with
   * regulator-defensible provenance so a 6-month-later case-file
   * lookup can answer "who ran this verification, when, against which
   * model" without going back to server logs.
   *
   *   - `reviewer`: operator-set identifier (initials, employee id,
   *     email — whatever the operator's audit policy requires). Pulled
   *     from `ReviewerBadge` localStorage. Optional; empty when the
   *     reviewer hasn't set the badge.
   *   - `verifiedAtIso`: timestamp captured at first paint of the
   *     result panel — i.e. when the verifier returned, not when
   *     the user happens to be looking at the result later.
   */
  audit?: {
    reviewer?: string;
    verifiedAtIso: string;
    /**
     * Wave-35c: client-perceived end-to-end timing in ms, captured
     * around the verify fetch in `page.tsx`. Distinct from
     * `result.timings.total` (server-side preprocess + ocr + vision
     * + matching only). The end-to-end number is what the user
     * actually waited; the audit trail should preserve it because
     * "the user waited X seconds" is part of the case file.
     */
    clientTimings?: {
      compressionMs: number;
      networkMs: number;
      totalMs: number;
    };
  };
}

/**
 * Wave-34 (audit-trail fields #22 + #29). Optional metadata stamped
 * into the JSON export envelope. The result envelope is what an
 * integrator or auditor opens to reconstruct what happened.
 */
export interface SingleJsonExportOptions {
  reviewer?: string;
  verifiedAtIso?: string;
  /** Wave-35c — client-perceived end-to-end timing (ms). */
  clientTimings?: {
    compressionMs: number;
    networkMs: number;
    totalMs: number;
  };
}

export interface BatchJsonExport {
  schema: "labelverify.v1.batch";
  exportedAt: string;
  count: number;
  passed: number;
  failed: number;
  review: number;
  errored: number;
  items: Array<{
    index: number;
    filename: string;
    status: BatchRowLike["status"];
    result?: VerifyResponse;
    error?: string;
  }>;
}

export function singleResultToJson(
  filename: string,
  result: VerifyResponse,
  options?: SingleJsonExportOptions,
): string {
  const out: SingleJsonExport = {
    schema: "labelverify.v1.single",
    exportedAt: new Date().toISOString(),
    filename,
    result,
    audit:
      options?.reviewer || options?.verifiedAtIso || options?.clientTimings
        ? {
            reviewer: options.reviewer,
            verifiedAtIso: options.verifiedAtIso ?? new Date().toISOString(),
            clientTimings: options.clientTimings,
          }
        : undefined,
  };
  return JSON.stringify(out, null, 2);
}

export function batchToJson(rows: BatchRowLike[]): string {
  let passed = 0;
  let failed = 0;
  let review = 0;
  let errored = 0;
  for (const r of rows) {
    if (r.status === "error") errored++;
    else if (r.result?.verdict === "pass") passed++;
    else if (r.result?.verdict === "fail") failed++;
    else if (r.result?.verdict === "review") review++;
  }
  const out: BatchJsonExport = {
    schema: "labelverify.v1.batch",
    exportedAt: new Date().toISOString(),
    count: rows.length,
    passed,
    failed,
    review,
    errored,
    items: rows.map((r) => {
      const baseItem = {
        index: r.index,
        filename: r.filename,
        status: r.status,
      };
      if (r.result) return { ...baseItem, result: r.result };
      if (r.error) return { ...baseItem, error: r.error };
      return baseItem;
    }),
  };
  return JSON.stringify(out, null, 2);
}

/**
 * Browser-only: trigger a file download from a text payload.
 *
 * Pattern: blob URL → invisible anchor → click → revoke URL. Same
 * approach as the existing BatchView CSV export, factored out so
 * SingleResult and BatchView both call it.
 */
export function triggerDownload(
  filename: string,
  text: string,
  mimeType: string,
): void {
  if (typeof window === "undefined" || typeof document === "undefined") {
    throw new Error("triggerDownload is browser-only.");
  }
  const blob = new Blob([text], { type: `${mimeType};charset=utf-8` });
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = filename;
  a.style.display = "none";
  document.body.appendChild(a);
  a.click();
  document.body.removeChild(a);
  // Defer revoke so older Safari has a tick to read the URL.
  setTimeout(() => URL.revokeObjectURL(url), 1_000);
}

/** A filesystem-safe basename derived from an original filename. */
export function safeStem(filename: string): string {
  const base = filename.split(/[\\/]/).pop() ?? filename;
  // Strip extension at the LAST dot. A leading-only dot ("name = .jpg")
  // means no actual stem — drop it entirely so we fall through to the
  // default. Otherwise keep everything before the final dot.
  const dot = base.lastIndexOf(".");
  const noExt = dot > 0 ? base.slice(0, dot) : dot === 0 ? "" : base;
  const cleaned = noExt
    .replace(/[^A-Za-z0-9._-]+/g, "-")
    .replace(/-+/g, "-")
    .replace(/^-|-$/g, "");
  return cleaned || "label";
}
