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

// Per-image budget for the verification phase. **4 500 ms** is the
// measured single-image P50 against production (N=3 probe wave-35j:
// 5102/5185/7011 ms client, 4498/4667/5965 ms server — see
// CHANGELOG wave-35j hypothesis matrix). The previous **3 000 ms**
// was anchored on the bench's *vision-call-only* number, which
// ignored preprocess + OCR + matching + Gov-Warning validation in
// the full pipeline. The result was the bar racing to 100% well
// before the server actually finished — exactly the accuracy bug
// the user flagged.
//
// The server runs `concurrency` images in parallel (default 16
// since wave-35j, was 12 since wave-15b, configurable via
// `INLINE_BATCH_CONCURRENCY`).
const PER_IMAGE_MS = 4_500;
// Mirror the server's INLINE_CONCURRENCY_DEFAULT in
// `src/app/api/verify/batch/route.ts`. Wave-35j bumped both from 12 → 16
// (with the batch function memory increased to 2 GB; safe at ~80 MB
// per worker).
const DEFAULT_CONCURRENCY = 16;

/**
 * Concave easing for the verifying phase. Pulls the bar up faster
 * during the first ~half of the elapsed budget so the user sees
 * immediate movement, then tapers as completion approaches — the
 * opposite of the linear-then-stuck-at-98% experience the previous
 * implementation produced. Mathematically `x^0.7` over [0..1]
 * (mild concavity): at t=0.25 elapsed we're at 36% of the phase
 * instead of 25%; at t=0.75 we're at 81% instead of 75%; at t=1.0
 * we're at 100% of the phase (no clamp surprise).
 */
function ease(t: number): number {
  return Math.pow(Math.max(0, Math.min(1, t)), 0.7);
}

function estimatedFraction(props: BatchProgressProps): number {
  const { phase, imageCount, uploadFraction, elapsedMs } = props;
  const concurrency = props.concurrency ?? DEFAULT_CONCURRENCY;
  const verifyBudget = Math.max(
    1_500,
    Math.ceil(imageCount / Math.max(1, concurrency)) * PER_IMAGE_MS,
  );
  switch (phase) {
    case "uploading": {
      // Upload phase = 0..25 % of the total bar (was 0..30 % pre
      // wave-35j; tightened because upload is a small fraction of
      // total time on the typical batch — pairing + verifying
      // dominate).
      const inner =
        uploadFraction !== undefined
          ? uploadFraction
          : Math.min(1, elapsedMs / 4_000);
      return inner * 0.25;
    }
    case "pairing":
      // Pairing phase = 25..50 % of the bar. Server-side, no real
      // signal from the inline-batch path; estimate via a 6 s budget
      // (content-pairing fingerprint extraction can take 3-5 s when
      // it fires) with concave easing.
      return 0.25 + ease(Math.min(1, elapsedMs / 6_000)) * 0.25;
    case "verifying":
      // Verification = 50..95 % of the bar. Concave easing so the
      // bar moves visibly in the first half of the budget rather
      // than crawling. Caps at 95 % (was 98 %) so the
      // `finalising` transition has a visible 5-point jump — the
      // previous 2-point jump was too small to register.
      return 0.5 + ease(Math.min(1, elapsedMs / verifyBudget)) * 0.45;
    case "finalising":
      return 0.95;
    case "idle":
      return 0;
  }
}

/**
 * Best-effort estimate of how many items have been verified by now,
 * given the wall-clock elapsed time and the effective concurrency.
 * Returns a number ≤ imageCount. Used in the status copy so the
 * reviewer sees real-feeling progress ("Verifying ~7 of 12…") in
 * addition to the percentage bar.
 *
 * Math: at concurrency C, a batch of N items takes ⌈N/C⌉ × PER_IMAGE_MS
 * end-to-end (assuming linear scaling, which empirically holds at
 * batches ≤ ~50 items). At time `elapsed`, we've completed
 * approximately `elapsed / PER_IMAGE_MS × C` items in parallel.
 */
function estimatedCompletedCount(
  imageCount: number,
  effectiveConcurrency: number,
  elapsedMs: number,
): number {
  if (imageCount <= 0 || effectiveConcurrency <= 0) return 0;
  // Per-item wall-clock in this batch (clamped concurrency).
  const itemsDone = (elapsedMs / PER_IMAGE_MS) * effectiveConcurrency;
  // Never overshoot the batch size; never claim more than imageCount-1
  // until the response actually lands (i.e. the phase flips to
  // `finalising`). The caller flips to `imageCount` at finalising.
  return Math.max(0, Math.min(imageCount - 1, Math.floor(itemsDone)));
}

function phaseLabel(props: BatchProgressProps): string {
  const { phase, imageCount, appCount, elapsedMs } = props;
  // Surface the EFFECTIVE concurrency the server is using for this
  // batch (clamped to the batch size) so the copy can't lie about
  // throughput. The server clamps via `Math.min(MAX_INLINE_CONCURRENCY,
  // job.items.length)` so a 3-item batch shows "concurrency 3", not
  // a nominal 16.
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
    case "verifying": {
      // Wave-35j accuracy fix: surface an estimated "≈ X of N
      // verified" count in addition to the concurrency badge. The
      // count comes from `estimatedCompletedCount` (elapsed-time × C /
      // PER_IMAGE_MS, clamped to imageCount-1) so the reviewer sees
      // real-feeling progress instead of a bar racing across an
      // opaque "verifying" phase. The "≈" prefix is deliberate —
      // the inline-batch path doesn't stream per-item events, so
      // the count is an estimate, not ground truth.
      const done = estimatedCompletedCount(
        imageCount,
        effectiveConcurrency,
        elapsedMs,
      );
      // For single-image batches the "≈ 0 of 1" copy is jarring;
      // fall back to the simple form there.
      if (imageCount <= 1) {
        return `Verifying ${imageCount} ${imgWord}…`;
      }
      return `Verifying ${imageCount} ${imgWord} (${effectiveConcurrency} in parallel) — ≈ ${done} of ${imageCount} done…`;
    }
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
