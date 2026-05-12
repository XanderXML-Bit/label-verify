"use client";

import { useEffect, useId, useMemo, useRef, useState } from "react";
import type { VerifyResponse } from "@/lib/types";
import { VerdictChip, QualityChip } from "./StatusChip";

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
}

export interface BatchSummary {
  passed: number;
  failed: number;
  review: number;
  errored: number;
}

type Filter = "all" | "failed" | "review" | "pass" | "error";

export function BatchView({ batchId, rows: initialRows, onDone }: BatchViewProps) {
  const [rows, setRows] = useState<BatchRow[]>(initialRows);
  const [done, setDone] = useState(false);
  const [filter, setFilter] = useState<Filter>("all");
  const [drilled, setDrilled] = useState<BatchRow | null>(null);

  // Open SSE on mount.
  useEffect(() => {
    const es = new EventSource(`/api/verify/batch/${batchId}/stream`);
    es.addEventListener("item", (ev: MessageEvent<string>) => {
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
      setDone(true);
      onDone(JSON.parse(ev.data) as BatchSummary);
      es.close();
    });
    es.onerror = () => {
      // Connection drop — leave the partial UI in place; user can reload.
    };
    return () => es.close();
  }, [batchId, onDone]);

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

  const pct = Math.round((counts.finished / rows.length) * 100);

  return (
    <section aria-labelledby="batch-heading" className="space-y-4">
      <header className="flex flex-wrap items-center justify-between gap-3">
        <h2 id="batch-heading" className="text-xl font-semibold text-slate-800">
          Batch verification
        </h2>
        <div aria-live="polite" className="text-sm text-slate-600">
          {counts.finished} / {rows.length} complete · {done ? "Done" : `${pct}%`}
        </div>
      </header>

      <div
        className="h-2 w-full overflow-hidden rounded bg-slate-200"
        role="progressbar"
        aria-valuemin={0}
        aria-valuemax={100}
        aria-valuenow={pct}
      >
        <div
          className="h-full bg-blue-500 transition-[width]"
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
        className="-mx-4 overflow-x-auto rounded-lg border border-slate-200 bg-white sm:mx-0"
        style={{ maxHeight: "60vh" }}
        role="region"
        aria-label="Batch results table"
        tabIndex={0}
      >
        <table className="min-w-full divide-y divide-slate-200 text-sm">
          <caption className="sr-only">
            One row per uploaded label, with verdict, image quality, and timing.
          </caption>
          <thead className="sticky top-0 bg-slate-50 text-left text-slate-600">
            <tr>
              <th scope="col" className="px-4 py-2 font-semibold">#</th>
              <th scope="col" className="px-4 py-2 font-semibold">File</th>
              <th scope="col" className="px-4 py-2 font-semibold">Verdict</th>
              <th scope="col" className="px-4 py-2 font-semibold">Image quality</th>
              <th scope="col" className="px-4 py-2 font-semibold">Time</th>
              <th scope="col" className="px-4 py-2 font-semibold">
                <span className="sr-only">Open</span>
              </th>
            </tr>
          </thead>
          <tbody className="divide-y divide-slate-100">
            {visibleRows.map((r) => (
              <Row key={r.index} row={r} onOpen={() => setDrilled(r)} />
            ))}
          </tbody>
        </table>
      </div>

      {drilled && drilled.status === "done" && (
        <DrilldownPanel row={drilled} onClose={() => setDrilled(null)} />
      )}

      {done && (
        <button
          type="button"
          onClick={() => downloadCsv(rows)}
          className="min-h-[44px] rounded-md bg-blue-600 px-5 py-2.5 text-sm font-semibold text-white hover:bg-blue-700"
        >
          Download CSV
        </button>
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
}: {
  readonly row: BatchRow & { status: "done" };
  readonly onClose: () => void;
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
      className="rounded-lg border border-slate-200 bg-white p-4"
    >
      <h3 id={headingId} className="text-lg font-semibold text-slate-800">
        {row.filename}
      </h3>
      <pre className="mt-2 max-h-96 overflow-auto text-xs">
        {JSON.stringify(row.result, null, 2)}
      </pre>
      <button
        ref={closeBtnRef}
        type="button"
        onClick={onClose}
        className="mt-3 min-h-[44px] rounded-md bg-slate-900 px-4 py-2.5 text-sm font-semibold text-white hover:bg-slate-700"
      >
        Close
      </button>
    </div>
  );
}

function Row({ row, onOpen }: { readonly row: BatchRow; readonly onOpen: () => void }) {
  return (
    <tr className="hover:bg-slate-50">
      <td className="px-4 py-2 text-slate-500">{row.index + 1}</td>
      <td className="px-4 py-2 font-mono text-xs">{row.filename}</td>
      <td className="px-4 py-2">
        {row.status === "done" ? (
          <VerdictChip verdict={row.result.verdict} size="sm" />
        ) : row.status === "error" ? (
          <span className="text-xs text-red-600">error</span>
        ) : row.status === "running" ? (
          <span className="text-xs text-slate-400">…</span>
        ) : (
          <span className="text-xs text-slate-400">queued</span>
        )}
      </td>
      <td className="px-4 py-2">
        {row.status === "done" && <QualityChip quality={row.result.imageQuality} size="sm" />}
      </td>
      <td className="px-4 py-2 text-slate-500">
        {row.status === "done" && `${(row.result.timings.total / 1000).toFixed(1)}s`}
      </td>
      <td className="px-4 py-2 text-right">
        {row.status === "done" && (
          <button
            type="button"
            onClick={onOpen}
            aria-label={`Open details for ${row.filename}`}
            className="rounded px-2 py-1 text-xs text-blue-600 hover:bg-blue-50 hover:underline"
          >
            Open
          </button>
        )}
        {row.status === "error" && (
          <span className="text-xs text-red-600">{row.error}</span>
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
          ? "bg-blue-600 text-white ring-blue-600"
          : "bg-white text-slate-700 ring-slate-300 hover:bg-slate-100"
      }`}
      aria-pressed={active}
    >
      {label}
    </button>
  );
}

function downloadCsv(rows: BatchRow[]): void {
  const header = [
    "index",
    "filename",
    "verdict",
    "image_quality",
    "gov_warning_status",
    "brand_status",
    "abv_status",
    "net_contents_status",
    "class_status",
    "producer_status",
    "country_status",
    "total_ms",
    "vision_ms",
  ];
  const body = rows.map((r) => {
    if (r.status !== "done") return [r.index, r.filename, r.status];
    const f = r.result.fields;
    return [
      r.index,
      r.filename,
      r.result.verdict,
      r.result.imageQuality,
      r.result.governmentWarning.status,
      f.brand_name.status,
      f.abv_percent.status,
      f.net_contents.status,
      f.class_type.status,
      f.producer.status,
      f.country_of_origin.status,
      r.result.timings.total,
      r.result.timings.vision,
    ];
  });
  const csv = [header, ...body]
    .map((row) => row.map((v) => `"${String(v).replace(/"/g, '""')}"`).join(","))
    .join("\n");
  const blob = new Blob([csv], { type: "text/csv;charset=utf-8" });
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = `label-verify-batch.csv`;
  a.click();
  URL.revokeObjectURL(url);
}
