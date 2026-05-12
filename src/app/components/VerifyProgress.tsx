"use client";

import { useEffect, useState } from "react";

// ─── VerifyProgress ────────────────────────────────────────────────────────
//
// Live elapsed-time counter + deterministic progress bar shown while the
// verify/extract request is in flight. Replaces the bare pulse stripe
// the previous "Checking the label… usually under 5 seconds" copy
// rendered — that pulse didn't tell the reviewer anything about whether
// the request was making progress.
//
// Design: the bar uses an ease-out curve that asymptotes toward 95% at
// the expected 5s mark; after 10s the copy softens ("Still working —
// larger images take a moment.") so a senior reviewer doesn't think
// the page is hung. Counter updates every 100ms; the bar update is
// debounced to every 100ms via the same hook so React doesn't render
// 60x/s.

interface Props {
  /** Copy under the bar. e.g. "Checking the label" or "Extracting fields". */
  readonly verb: string;
  /**
   * Soft target the bar eases toward. Past this point the bar caps at
   * 95% (we don't claim 100% until the response arrives). Default 5s.
   */
  readonly expectedMs?: number;
}

const DEFAULT_EXPECTED_MS = 5_000;
const LONG_WAIT_THRESHOLD_MS = 10_000;
const TICK_MS = 100;

export function VerifyProgress({
  verb,
  expectedMs = DEFAULT_EXPECTED_MS,
}: Props) {
  const [elapsed, setElapsed] = useState(0);

  useEffect(() => {
    const start = performance.now();
    const t = setInterval(() => {
      setElapsed(performance.now() - start);
    }, TICK_MS);
    return () => clearInterval(t);
  }, []);

  // Ease-out curve toward 0.95 over expectedMs. At t == expectedMs we
  // hit ~0.86; the asymptote continues toward 0.95 for the next several
  // seconds. After 10 seconds we hold at 0.95 (we don't want to crawl
  // past it and look like the page is hung at 99%).
  const progress = Math.min(
    0.95,
    1 - Math.exp(-elapsed / (expectedMs * 0.6)) * 0.95,
  );
  const longWait = elapsed >= LONG_WAIT_THRESHOLD_MS;

  // Format elapsed as seconds with one decimal (e.g. "2.4 s"). Cleaner
  // for the user than ms.
  const elapsedSec = (elapsed / 1000).toFixed(1);

  return (
    <div
      className="rounded-lg border border-slate-200 bg-white p-6 dark:border-slate-700 dark:bg-slate-900"
      aria-busy="true"
    >
      <div className="flex flex-wrap items-baseline justify-between gap-2">
        <p
          className="text-base text-slate-700 dark:text-slate-200"
          aria-live="polite"
        >
          {verb}…{" "}
          <span className="font-mono text-slate-500 dark:text-slate-400">
            {elapsedSec} s
          </span>
        </p>
        {longWait && (
          <span className="text-xs text-slate-500 dark:text-slate-400">
            Larger or more detailed images take a moment.
          </span>
        )}
      </div>
      <div className="mt-3 h-2 w-full overflow-hidden rounded bg-slate-200 dark:bg-slate-700">
        <div
          className="h-full bg-blue-500 transition-[width] duration-200 ease-out dark:bg-blue-400"
          style={{ width: `${(progress * 100).toFixed(1)}%` }}
        />
      </div>
    </div>
  );
}
