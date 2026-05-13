"use client";

import { useEffect, useId, useMemo, useRef, useState } from "react";
import type { VerifyResponse } from "@/lib/types";
import { VerdictChip, QualityChip } from "./StatusChip";
import { SingleResult } from "./SingleResult";
import {
  batchToCsv,
  batchToJson,
  triggerDownload,
} from "@/lib/export-result";

export type BatchRow =
  | { index: number; filename: string; status: "pending" }
  | { index: number; filename: string; status: "running" }
  | {
      index: number;
      filename: string;
      status: "done";
      result: VerifyResponse;
    }
  | { index: number; filename: string; status: "error"; error: string };

interface BatchViewProps {
  readonly batchId: string;
  readonly rows: BatchRow[];
  readonly onDone: (summary: BatchSummary) => void;
  /**
   * filename → blob: URL, built by the parent at submit time from
   * the uploaded File objects. Used to render per-row thumbnails so
   * the operator can visually associate each verdict with the image
   * they sent, without re-fetching anything from the server. The
   * drilldown panel also reads from this map. Omitted (or empty)
   * disables thumbnails — falls back to a small placeholder.
   */
  readonly imagePreviewByFilename?: Readonly<Record<string, string>>;
}

export interface BatchSummary {
  passed: number;
  failed: number;
  review: number;
  errored: number;
}

type Filter = "all" | "failed" | "review" | "pass" | "error";

/**
 * Look up a preview URL for the row's filename, with defensive
 * fallbacks. The exact-match key is the primary path; the fallbacks
 * handle production data drift between client (where the previewMap
 * is built from `f.name`) and server (which echoes back `imageFile.name`
 * — should match but in practice we've observed encoding drift,
 * basename normalization, and folder-pick path-prefix differences).
 *
 * The cost of an extra lookup vs. an extra dashed-placeholder is
 * obvious — surfacing the thumbnail is the operator-facing win.
 */
function resolvePreviewUrl(
  rowFilename: string,
  preview: Readonly<Record<string, string>> | undefined,
): string | undefined {
  if (!preview) return undefined;
  // 1) Exact match — the happy path.
  const direct = preview[rowFilename];
  if (direct) return direct;
  // 2) Decode URI-component (rare but possible if the server URL-
  // encoded the filename — e.g. a file with spaces).
  try {
    const decoded = decodeURIComponent(rowFilename);
    if (decoded !== rowFilename && preview[decoded]) return preview[decoded];
  } catch {
    /* malformed escape sequence — ignore */
  }
  // 3) Basename of the row's filename — strips any forward-or-back-slash
  // path prefix the server might have surfaced.
  const lastSlash = Math.max(
    rowFilename.lastIndexOf("/"),
    rowFilename.lastIndexOf("\\"),
  );
  if (lastSlash >= 0) {
    const base = rowFilename.slice(lastSlash + 1);
    if (preview[base]) return preview[base];
  }
  // 4) Reverse lookup — find a preview key whose basename matches the
  // row's basename. Handles the folder-pick case where one side stored
  // the full webkitRelativePath and the other stored just the leaf.
  const rowBase = lastSlash >= 0 ? rowFilename.slice(lastSlash + 1) : rowFilename;
  for (const key of Object.keys(preview)) {
    const keyLastSlash = Math.max(
      key.lastIndexOf("/"),
      key.lastIndexOf("\\"),
    );
    const keyBase = keyLastSlash >= 0 ? key.slice(keyLastSlash + 1) : key;
    if (keyBase === rowBase) return preview[key];
  }
  return undefined;
}

export function BatchView({
  batchId,
  rows: initialRows,
  onDone,
  imagePreviewByFilename,
}: BatchViewProps) {
  // Inline-batch detection (2026-05-13): if every row arrives already
  // in a terminal state (`done` or `error`), the POST returned inline
  // results — no SSE needed. Vercel serverless can't share the in-memory
  // batch-store between the POST instance and the SSE GET instance, so
  // opening an EventSource would 404 on the next-instance miss. Skip it.
  const allRowsTerminal =
    initialRows.length > 0 &&
    initialRows.every((r) => r.status === "done" || r.status === "error");
  const [rows, setRows] = useState<BatchRow[]>(initialRows);
  const [done, setDone] = useState(allRowsTerminal);
  const [filter, setFilter] = useState<Filter>("all");
  const [drilled, setDrilled] = useState<BatchRow | null>(null);
  // SSE connection state. Surfaced as a banner so a user whose
  // network drops mid-batch sees an actionable "reconnect" affordance
  // rather than a silently-stalled progress bar.
  const [connectionLost, setConnectionLost] = useState(false);
  const [reconnectKey, setReconnectKey] = useState(0);

  // Emit the inline-batch summary up to the parent once on mount.
  useEffect(() => {
    if (!allRowsTerminal) return;
    const passed = initialRows.filter((r) => r.status === "done" && r.result?.verdict === "pass").length;
    const failed = initialRows.filter((r) => r.status === "done" && r.result?.verdict === "fail").length;
    const review = initialRows.filter((r) => r.status === "done" && r.result?.verdict === "review").length;
    const errored = initialRows.filter((r) => r.status === "error").length;
    onDone({ passed, failed, review, errored });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // Open SSE on mount; refreshed when the user clicks reconnect. The
  // inline-batch path returns terminal rows in the initial response —
  // skip the SSE entirely in that case (no Vercel-instance race).
  // eslint-disable-next-line react-hooks/exhaustive-deps
  useEffect(() => {
    if (allRowsTerminal) return;
    const es = new EventSource(`/api/verify/batch/${batchId}/stream`);
    let closed = false;
    es.addEventListener("item", (ev: MessageEvent<string>) => {
      setConnectionLost(false);
      const data = JSON.parse(ev.data) as {
        index: number;
        filename: string;
        status: "done" | "error";
        result?: VerifyResponse;
        error?: string;
      };
      setRows((prev) => {
        const next = prev.slice();
        next[data.index] = data.status === "done"
          ? {
              index: data.index,
              filename: data.filename,
              status: "done",
              result: data.result!,
            }
          : {
              index: data.index,
              filename: data.filename,
              status: "error",
              error: data.error ?? "Unknown error",
            };
        return next;
      });
    });
    es.addEventListener("done", (ev: MessageEvent<string>) => {
      closed = true;
      setDone(true);
      setConnectionLost(false);
      onDone(JSON.parse(ev.data) as BatchSummary);
      es.close();
    });
    es.onerror = () => {
      // EventSource fires onerror both for transient hiccups (auto-
      // reconnect kicks in) and for terminal drops (readyState ===
      // CLOSED). Surface a banner only on terminal drops; transient
      // ones will reconnect themselves.
      if (closed) return;
      if (es.readyState === EventSource.CLOSED) {
        setConnectionLost(true);
      }
    };
    return () => {
      closed = true;
      es.close();
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [batchId, onDone, reconnectKey]);

  const counts = useMemo(() => {
    let passed = 0;
    let failed = 0;
    let review = 0;
    let errored = 0;
    for (const r of rows) {
      if (r.status === "done") {
        if (r.result.verdict === "pass") passed++;
        else if (r.result.verdict === "fail") failed++;
        else review++;
      } else if (r.status === "error") errored++;
    }
    const finished = passed + failed + review + errored;
    return { passed, failed, review, errored, finished };
  }, [rows]);

  const visibleRows = useMemo(() => {
    switch (filter) {
      case "failed":
        return rows.filter((r) => r.status === "done" && r.result.verdict === "fail");
      case "review":
        return rows.filter((r) => r.status === "done" && r.result.verdict === "review");
      case "pass":
        return rows.filter((r) => r.status === "done" && r.result.verdict === "pass");
      case "error":
        return rows.filter((r) => r.status === "error");
      default:
        return rows;
    }
  }, [rows, filter]);

  // Guard against `rows.length === 0` to avoid the historical "NaN%"
  // bug surfacing in the progress header when an empty batch lands
  // (e.g. after every row paired with a pairingError).
  const pct =
    rows.length === 0
      ? 0
      : Math.round((counts.finished / rows.length) * 100);

  return (
    <section aria-labelledby="batch-heading" className="space-y-4">
      <header className="flex flex-wrap items-center justify-between gap-3">
        <h2 id="batch-heading" className="text-xl font-semibold text-slate-800 dark:text-slate-100">
          Batch verification
        </h2>
        <div aria-live="polite" className="text-sm text-slate-600 dark:text-slate-300">
          {counts.finished} / {rows.length} complete · {done ? "Done" : `${pct}%`}
        </div>
      </header>

      {connectionLost && !done && (
        <div
          role="alert"
          aria-live="assertive"
          className="rounded-lg border border-yellow-300 bg-yellow-50 p-3 text-sm text-yellow-900 dark:border-yellow-700 dark:bg-yellow-950/60 dark:text-yellow-200"
        >
          <p className="font-semibold">
            <span aria-hidden className="mr-1">⚠</span>
            Connection to the batch stream dropped
          </p>
          <p className="mt-1">
            Already-completed rows are still shown. The remaining items
            won&apos;t update until you reconnect.
          </p>
          <button
            type="button"
            onClick={() => {
              setConnectionLost(false);
              setReconnectKey((k) => k + 1);
            }}
            className="mt-2 min-h-[44px] rounded-md bg-yellow-700 px-4 py-2 text-sm font-semibold text-white hover:bg-yellow-800 dark:bg-yellow-600 dark:hover:bg-yellow-500"
          >
            Reconnect
          </button>
        </div>
      )}

      <div
        className="h-2 w-full overflow-hidden rounded bg-slate-200 dark:bg-slate-700"
        role="progressbar"
        aria-valuemin={0}
        aria-valuemax={100}
        aria-valuenow={pct}
      >
        <div
          className="h-full bg-blue-500 transition-[width] dark:bg-blue-400"
          style={{ width: `${pct}%` }}
        />
      </div>

      <div className="flex flex-wrap gap-2 text-sm">
        <FilterPill label={`All (${rows.length})`} active={filter === "all"} onClick={() => setFilter("all")} />
        <FilterPill label={`Pass (${counts.passed})`} active={filter === "pass"} onClick={() => setFilter("pass")} />
        <FilterPill label={`Fail (${counts.failed})`} active={filter === "failed"} onClick={() => setFilter("failed")} />
        <FilterPill label={`Review (${counts.review})`} active={filter === "review"} onClick={() => setFilter("review")} />
        <FilterPill label={`Errored (${counts.errored})`} active={filter === "error"} onClick={() => setFilter("error")} />
      </div>

      <div
        className="-mx-4 overflow-x-auto rounded-lg border border-slate-200 bg-white dark:border-slate-700 dark:bg-slate-900 sm:mx-0"
        style={{ maxHeight: "60vh" }}
        role="region"
        aria-label="Batch results table"
        tabIndex={0}
      >
        <table className="min-w-full divide-y divide-slate-200 text-sm dark:divide-slate-700">
          <caption className="sr-only">
            One row per uploaded label, with verdict, image quality, and timing.
          </caption>
          <thead className="sticky top-0 bg-slate-50 text-left text-slate-600 dark:bg-slate-800 dark:text-slate-300">
            <tr>
              <th scope="col" className="px-4 py-2 font-semibold">#</th>
              <th scope="col" className="px-4 py-2 font-semibold">
                <span className="sr-only">Thumbnail</span>
              </th>
              <th scope="col" className="px-4 py-2 font-semibold">File</th>
              <th scope="col" className="px-4 py-2 font-semibold">Verdict</th>
              <th scope="col" className="px-4 py-2 font-semibold">Image quality</th>
              <th scope="col" className="px-4 py-2 font-semibold">Time</th>
              <th scope="col" className="px-4 py-2 font-semibold">
                <span className="sr-only">Open</span>
              </th>
            </tr>
          </thead>
          <tbody className="divide-y divide-slate-100 dark:divide-slate-800">
            {visibleRows.map((r) => (
              <Row
                key={r.index}
                row={r}
                onOpen={() => setDrilled(r)}
                previewUrl={resolvePreviewUrl(r.filename, imagePreviewByFilename)}
              />
            ))}
          </tbody>
        </table>
      </div>

      {drilled && drilled.status === "done" && (
        <DrilldownPanel
          row={drilled}
          onClose={() => setDrilled(null)}
          previewUrl={
            resolvePreviewUrl(drilled.filename, imagePreviewByFilename) ?? ""
          }
        />
      )}

      {done && (
        <div className="flex flex-wrap items-center gap-2">
          <button
            type="button"
            onClick={() =>
              triggerDownload(
                "label-verify-batch.json",
                batchToJson(rows),
                "application/json",
              )
            }
            className="min-h-[44px] rounded-md bg-blue-600 px-5 py-2.5 text-sm font-semibold text-white hover:bg-blue-700 dark:bg-blue-500 dark:hover:bg-blue-400"
            aria-label="Download the full batch result as a JSON file"
          >
            Download JSON
          </button>
          <button
            type="button"
            onClick={() =>
              triggerDownload(
                "label-verify-batch.csv",
                batchToCsv(rows),
                "text/csv",
              )
            }
            className="min-h-[44px] rounded-md border border-blue-600 px-5 py-2.5 text-sm font-medium text-blue-700 hover:bg-blue-50 dark:border-blue-400 dark:text-blue-300 dark:hover:bg-blue-950/40"
            aria-label="Download the batch result as a CSV file"
          >
            Download CSV
          </button>
        </div>
      )}
    </section>
  );
}

// Detail panel for a drilled-down batch row. Implements a soft focus
// trap: Tab cycles within the panel until the user presses Escape or
// clicks Close. We intentionally don't full-modalize (the rest of the
// page stays visible and scrollable) — it's a side panel, not a dialog.
function DrilldownPanel({
  row,
  onClose,
  previewUrl,
}: {
  readonly row: BatchRow & { status: "done" };
  readonly onClose: () => void;
  /** blob: URL built by the parent at submit time. Empty string when
   *  the batch was re-opened from a URL or some other path without
   *  access to the original File objects — SingleResult renders the
   *  "No preview" stub in that case. */
  readonly previewUrl: string;
}) {
  const containerRef = useRef<HTMLDivElement>(null);
  const closeBtnRef = useRef<HTMLButtonElement>(null);
  const headingId = useId();

  // Move focus into the panel on open.
  useEffect(() => {
    closeBtnRef.current?.focus();
  }, []);

  // Escape closes, Tab cycles within the panel.
  useEffect(() => {
    function onKey(e: KeyboardEvent) {
      if (e.key === "Escape") {
        e.preventDefault();
        onClose();
        return;
      }
      if (e.key !== "Tab") return;
      const root = containerRef.current;
      if (!root) return;
      const focusables = root.querySelectorAll<HTMLElement>(
        'button, [href], input, select, textarea, [tabindex]:not([tabindex="-1"])',
      );
      if (focusables.length === 0) return;
      const first = focusables[0]!;
      const last = focusables[focusables.length - 1]!;
      const active = document.activeElement as HTMLElement | null;
      if (e.shiftKey && active === first) {
        e.preventDefault();
        last.focus();
      } else if (!e.shiftKey && active === last) {
        e.preventDefault();
        first.focus();
      }
    }
    document.addEventListener("keydown", onKey);
    return () => document.removeEventListener("keydown", onKey);
  }, [onClose]);

  return (
    <div
      ref={containerRef}
      role="region"
      aria-labelledby={headingId}
      className="rounded-lg border border-slate-200 bg-white p-4 dark:border-slate-700 dark:bg-slate-900"
    >
      <div className="flex flex-wrap items-center justify-between gap-2">
        <h3
          id={headingId}
          className="text-lg font-semibold text-slate-800 dark:text-slate-100"
        >
          {row.filename}
        </h3>
        <button
          ref={closeBtnRef}
          type="button"
          onClick={onClose}
          className="min-h-[44px] rounded-md bg-slate-900 px-4 py-2.5 text-sm font-semibold text-white hover:bg-slate-700 dark:bg-blue-600 dark:hover:bg-blue-500"
        >
          Close
        </button>
      </div>
      <div className="mt-4">
        {/* Parent passes a blob: URL keyed by filename so the drilldown
            renders the exact image the operator uploaded. Empty string
            falls through to SingleResult's "No preview" stub. */}
        <SingleResult
          result={row.result}
          imagePreviewUrl={previewUrl}
          onAnother={onClose}
        />
      </div>
    </div>
  );
}

function Row({
  row,
  onOpen,
  previewUrl,
}: {
  readonly row: BatchRow;
  readonly onOpen: () => void;
  /** blob: URL built by the parent at submit time. The thumbnail
   *  cell falls back to a placeholder when undefined (e.g. a batch
   *  view re-opened from a URL without access to the original
   *  File objects). */
  readonly previewUrl?: string;
}) {
  return (
    <tr className="hover:bg-slate-50 dark:hover:bg-slate-800">
      <td className="px-4 py-2 text-slate-500 dark:text-slate-400">{row.index + 1}</td>
      <td className="px-4 py-2">
        {previewUrl ? (
          <button
            type="button"
            onClick={onOpen}
            aria-label={`Open details for ${row.filename}`}
            className="block h-12 w-12 overflow-hidden rounded border border-slate-200 bg-white focus:outline-none focus-visible:ring-2 focus-visible:ring-sky-500 dark:border-slate-700 dark:bg-slate-800"
            title={`Open details for ${row.filename}`}
          >
            {/* eslint-disable-next-line @next/next/no-img-element -- blob: URL from the user's upload */}
            <img
              src={previewUrl}
              alt={`Thumbnail of ${row.filename}`}
              loading="lazy"
              decoding="async"
              className="h-full w-full object-cover"
            />
          </button>
        ) : (
          <div
            aria-hidden
            className="h-12 w-12 rounded border border-dashed border-slate-300 bg-slate-100 dark:border-slate-600 dark:bg-slate-800"
          />
        )}
      </td>
      <td className="px-4 py-2 font-mono text-xs text-slate-800 dark:text-slate-200">{row.filename}</td>
      <td className="px-4 py-2">
        {row.status === "done" ? (
          <VerdictChip verdict={row.result.verdict} size="sm" />
        ) : row.status === "error" ? (
          <span className="text-xs text-red-600 dark:text-red-400">error</span>
        ) : row.status === "running" ? (
          <span className="text-xs text-slate-400 dark:text-slate-500">…</span>
        ) : (
          <span className="text-xs text-slate-400 dark:text-slate-500">queued</span>
        )}
      </td>
      <td className="px-4 py-2">
        {row.status === "done" && <QualityChip quality={row.result.imageQuality} size="sm" />}
      </td>
      <td className="px-4 py-2 text-slate-500 dark:text-slate-400">
        {row.status === "done" && `${(row.result.timings.total / 1000).toFixed(1)}s`}
      </td>
      <td className="px-4 py-2 text-right">
        {row.status === "done" && (
          <button
            type="button"
            onClick={onOpen}
            aria-label={`Open details for ${row.filename}`}
            className="rounded px-2 py-1 text-xs text-blue-600 hover:bg-blue-50 hover:underline dark:text-blue-400 dark:hover:bg-blue-950"
          >
            Open
          </button>
        )}
        {row.status === "error" && (
          <span className="text-xs text-red-600 dark:text-red-400">{row.error}</span>
        )}
      </td>
    </tr>
  );
}

function FilterPill({
  label,
  active,
  onClick,
}: {
  readonly label: string;
  readonly active: boolean;
  readonly onClick: () => void;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      className={`rounded-full px-3 py-1.5 ring-1 ring-inset transition-colors ${
        active
          ? "bg-blue-600 text-white ring-blue-600 dark:bg-blue-500 dark:ring-blue-500"
          : "bg-white text-slate-700 ring-slate-300 hover:bg-slate-100 dark:bg-slate-800 dark:text-slate-200 dark:ring-slate-600 dark:hover:bg-slate-700"
      }`}
      aria-pressed={active}
    >
      {label}
    </button>
  );
}

// CSV / JSON export helpers were extracted to src/lib/export-result.ts
// so SingleResult and BatchView share one implementation. The new CSV
// shape includes per-field confidence, the full Gov-Warning subscore
// quartet, review reasons, fallback indicator, and model identifier —
// strictly richer than the previous BatchView-local version.
