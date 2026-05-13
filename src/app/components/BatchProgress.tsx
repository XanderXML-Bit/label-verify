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
   *  time estimate (~3 s / 2-concurrency per image at P50). */
  imageCount: number;
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
}

// Rough per-image budget for the verification phase. 3 000 ms is the
// measured P50 for a single verify; with CONCURRENCY=2 in the batch
// route, two images run in parallel. The bar uses this to estimate
// completion percentage while the server is processing inline.
const PER_IMAGE_MS = 3_000;
const CONCURRENCY = 2;

function estimatedFraction(props: BatchProgressProps): number {
  const { phase, imageCount, uploadFraction, elapsedMs } = props;
  const verifyBudget = Math.max(
    1_000,
    (Math.ceil(imageCount / CONCURRENCY) * PER_IMAGE_MS),
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
      return `Verifying ${imageCount} ${imgWord} (concurrency ${CONCURRENCY})…`;
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
        <span className="tabular-nums" aria-hidden>
          {pct}%
        </span>
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
