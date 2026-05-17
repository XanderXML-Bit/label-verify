"use client";

import { useEffect, useState } from "react";

export type BatchPhase =
  | "uploading"
  | "pairing"
  | "verifying"
  | "finalising"
  | "idle";

export interface BatchProgressProps {
  /** Where in the pipeline the batch currently is. The component
   *  estimates progress within the phase and across phases. */
  phase: BatchPhase;
  /** Number of images being verified. Used for verification-phase
   *  time estimate (~3 s per image at P50, divided by `concurrency`). */
  imageCount: number;
  /** Server-side worker concurrency for this batch. The verify route
   *  defaults to `INLINE_BATCH_CONCURRENCY` (12), capped at the actual
   *  batch size. Surfaced in the status copy so the time estimate
   *  matches reality and the operator's mental model of throughput
   *  doesn't drift from the actual server behaviour. Optional —
   *  defaults to 12 when omitted (matches server INLINE_CONCURRENCY_DEFAULT).
   *
   *  Historical: this used to be a hardcoded `2` constant on the
   *  client, which was correct for wave-12 (CONCURRENCY=2 in the
   *  batch route). Wave-15b bumped the server to 12 but the UI
   *  string was never updated — the bar said "concurrency 2" while
   *  the server was actually running 12 workers. Now passed through
   *  from the API response so the two can never diverge again. */
  concurrency?: number;
  /** Number of application files dropped (single roster manifest = 1).
   *  Surfaced in the status copy so the operator sees what the server
   *  is matching. */
  appCount: number;
  /** Upload progress 0..1 when known (XHR onprogress is real data).
   *  When undefined, the uploading phase shows an estimated 0-30 %
   *  ramp instead of the real value. */
  uploadFraction?: number;
  /** Milliseconds since the operator clicked "Verify batch". The
   *  parent passes this via a setInterval to keep the bar ticking
   *  even when the server is silent. */
  elapsedMs: number;
  /**
   * Optional cancel handler. When provided, a Cancel button is
   * rendered in the progress banner so an operator who realises
   * mid-upload that they chose the wrong batch can abort the XHR
   * and get back to batch-pending immediately. Wave-34 audit #30.
   */
  onCancel?: () => void;
}

// Rough per-image budget for the verification phase. 3 000 ms is the
// measured P50 for a single verify. The server runs `concurrency`
// images in parallel (default 12 since wave-15b, configurable via
// INLINE_BATCH_CONCURRENCY). The bar uses this to estimate
// completion percentage while the server is processing inline.
const PER_IMAGE_MS = 3_000;
const DEFAULT_CONCURRENCY = 12;

function estimatedFraction(props: BatchProgressProps): number {
  const { phase, imageCount, uploadFraction, elapsedMs } = props;
  const concurrency = props.concurrency ?? DEFAULT_CONCURRENCY;
  const verifyBudget = Math.max(
    1_000,
    (Math.ceil(imageCount / Math.max(1, concurrency)) * PER_IMAGE_MS),
  );
  switch (phase) {
    case "uploading": {
      // Upload phase = 0..30 % of the total bar.
      const inner =
        uploadFraction !== undefined
          ? uploadFraction
          : Math.min(1, elapsedMs / 4_000);
      return inner * 0.3;
    }
    case "pairing":
      // Pairing phase = 30..50 % of the bar. Server-side, no real
      // signal; estimate ~2 s of work + bounded.
      return 0.3 + Math.min(1, elapsedMs / 6_000) * 0.2;
    case "verifying":
      // Verification = 50..98 %. Linear in time vs the per-image
      // budget. Caps at 98 % so the bar doesn't sit at "100 %" while
      // the server is still wrapping up.
      return 0.5 + Math.min(1, elapsedMs / verifyBudget) * 0.48;
    case "finalising":
      return 0.98;
    case "idle":
      return 0;
  }
}

function phaseLabel(props: BatchProgressProps): string {
  const { phase, imageCount, appCount } = props;
  // Surface the EFFECTIVE concurrency the server is using for this
  // batch (clamped to the batch size) so the copy can't lie about
  // throughput. The server clamps via `Math.min(MAX_INLINE_CONCURRENCY,
  // job.items.length)` so a 3-item batch shows "concurrency 3", not
  // a nominal 12.
  const effectiveConcurrency = Math.min(
    props.concurrency ?? DEFAULT_CONCURRENCY,
    Math.max(1, imageCount),
  );
  const imgWord = imageCount === 1 ? "image" : "images";
  const appWord = appCount === 1 ? "application file" : "application files";
  switch (phase) {
    case "uploading":
      return `Uploading ${imageCount} ${imgWord}${
        appCount > 0 ? ` + ${appCount} ${appWord}` : ""
      }…`;
    case "pairing":
      return `Pairing on the server (inline-manifest → filename → content → broadcast, falls back as needed)…`;
    case "verifying":
      return `Verifying ${imageCount} ${imgWord} (${effectiveConcurrency} in parallel)…`;
    case "finalising":
      return `Finalising results…`;
    case "idle":
      return "";
  }
}

/**
 * Determinate progress bar for the batch-submit flow.
 *
 * The four-stage pairing pipeline runs server-side and does not emit
 * intermediate signals on the inline batch path, so the bar's
 * progress within the pairing + verifying phases is an estimate
 * keyed off the per-image P50 latency and image count. Upload
 * progress (when available via XHR onprogress) is the only real
 * data point. This is intentional: a moving determinate bar reads as
 * "I have a plan and I am partway through it" — much better than an
 * indeterminate spinner that reads as "I am waiting for something I
 * can't predict."
 *
 * Accessibility: progressbar role with aria-valuenow/valuemin/valuemax.
 */
export function BatchProgress(props: BatchProgressProps) {
  // Re-render on a tick so the bar smoothly advances even when the
  // parent's `elapsedMs` prop hasn't changed since the last paint.
  // Cheap (every 200 ms while mounted).
  const [, setTick] = useState(0);
  useEffect(() => {
    if (props.phase === "idle") return;
    const id = setInterval(() => setTick((t) => t + 1), 200);
    return () => clearInterval(id);
  }, [props.phase]);

  const f = Math.max(0, Math.min(1, estimatedFraction(props)));
  const pct = Math.round(f * 100);

  if (props.phase === "idle") return null;

  return (
    <div
      role="status"
      aria-live="polite"
      className="mt-3 rounded-md border-l-4 border-blue-500 bg-blue-50 p-3 text-sm text-blue-900 dark:border-blue-400 dark:bg-blue-950/60 dark:text-blue-200"
    >
      <div className="flex items-center justify-between gap-3">
        <span className="font-medium">{phaseLabel(props)}</span>
        <div className="flex items-center gap-3">
          <span className="tabular-nums" aria-hidden>
            {pct}%
          </span>
          {props.onCancel ? (
            <button
              type="button"
              onClick={props.onCancel}
              aria-label="Cancel batch verification"
              className="min-h-[32px] rounded-md border border-blue-700/40 px-2 py-1 text-xs text-blue-900 hover:bg-blue-100 dark:border-blue-300/40 dark:text-blue-100 dark:hover:bg-blue-900/40"
            >
              Cancel
            </button>
          ) : null}
        </div>
      </div>
      <div
        role="progressbar"
        aria-valuenow={pct}
        aria-valuemin={0}
        aria-valuemax={100}
        aria-label="Batch verification progress"
        className="mt-2 h-2 w-full overflow-hidden rounded bg-blue-100 dark:bg-blue-900/60"
      >
        <div
          className="h-full rounded bg-blue-600 transition-all duration-200 ease-out dark:bg-blue-400"
          style={{ width: `${pct}%` }}
        />
      </div>
      <div className="mt-2 text-xs text-blue-800/80 dark:text-blue-300/80">
        Server matches files in four stages (cheapest first): one CSV/
        JSON manifest covering many images, then filename-stem matching,
        then content-similarity for randomly-named files, then a
        single-application broadcast when one application file applies
        to every image. The phase above updates as each stage completes.
      </div>
    </div>
  );
}
