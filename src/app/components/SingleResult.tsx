"use client";

import { useEffect, useMemo, useState } from "react";
import type { VerifyResponse } from "@/lib/types";
import type { FieldComparison } from "@/lib/matching";
import { VerdictChip, QualityChip } from "./StatusChip";
import { ImageZoom } from "./ImageZoom";
import { getStoredReviewer } from "./ReviewerBadge";
import {
  safeStem,
  singleResultToCsv,
  singleResultToJson,
  triggerDownload,
} from "@/lib/export-result";

// Wave-35 Track 1 #2 (audit cleanup): the per-call cost table used to
// live here as a client-side `COST_PER_CALL_BY_MODEL` constant. The
// server already knows the model id that ran (it owns the extractor
// selection), so the cost is now computed server-side and shipped on
// `result.costUsd`. The component reads that field directly. The
// canonical table lives at `src/lib/vision/cost.ts`.

/** Plain-English field labels for the simple-mode "things to double-
 *  check" summary. Maps the per-field comparator's `field` key to a
 *  reviewer-friendly label. Used only in simple mode; detailed mode
 *  surfaces the canonical FieldRow component instead. */
const FIELD_LABEL_FROM_KEY: Record<string, string> = {
  brand_name: "Brand name",
  class_type: "Class / type",
  abv_percent: "ABV",
  net_contents: "Net contents",
  producer: "Producer",
  country_of_origin: "Country of origin",
  government_warning: "Government warning",
};


/**
 * Client-perceived end-to-end timing. Captured in `page.tsx` around
 * the verify / sample fetch. Surfaced in the result panel header and
 * the Audit details section so the user-visible time matches what
 * the user actually waited — not just `result.timings.total` from
 * the bench harness. Wave-35c.
 */
interface ClientTimings {
  /** Image-compression time on the client. */
  compressionMs: number;
  /** Network round-trip + server total + response-parse time. */
  networkMs: number;
  /** Full user-perceived end-to-end: click → result visible. */
  totalMs: number;
}

interface SingleResultProps {
  readonly result: VerifyResponse;
  readonly imagePreviewUrl: string;
  readonly onAnother: () => void;
  /** Original filename — used to name the JSON / CSV export files. */
  readonly filename?: string;
  /** Wave-35c: client-perceived end-to-end timing. Optional so existing
   *  test renders don't break. When present, surfaces in the header
   *  and the Audit details panel. */
  readonly clientTimings?: ClientTimings;
}

export function SingleResult({
  result,
  imagePreviewUrl,
  onAnother,
  filename,
  clientTimings,
}: SingleResultProps) {
  // Sort fields: failures first, then review, then pass. The bordered
  // emphasis on FAIL rows comes from `FieldRow` below.
  const fields = useMemo(() => orderedFields(result), [result]);
  const gov = result.governmentWarning;
  // Audit-trail metadata (wave-34). The reviewer id is read from
  // localStorage (set in the header by ReviewerBadge); the timestamp
  // is captured at first paint of this result panel — so the audit
  // entry reflects when the verifier ran, not when the user happens
  // to be looking at it. The component intentionally does NOT
  // re-read the reviewer on every render, so a reviewer who changes
  // their ID mid-result-view doesn't retroactively stamp the
  // existing card.
  const [reviewerAtVerifyTime, setReviewerAtVerifyTime] = useState<string>("");
  const [verifiedAtIso] = useState<string>(() => new Date().toISOString());
  useEffect(() => {
    setReviewerAtVerifyTime(getStoredReviewer());
    // Intentionally only run on mount — see above for why.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  return (
    <section aria-labelledby="results-heading" className="space-y-6">
      <header className="flex flex-wrap items-center justify-between gap-3">
        <h2 id="results-heading" className="text-xl font-semibold text-slate-800 dark:text-slate-100">
          Verification result
        </h2>
        <span
          className="detailed-only text-sm text-slate-500 dark:text-slate-400"
        >
          {/* Wave-35c: show user-perceived end-to-end time when we
              have it (captured around the fetch in page.tsx). Falls
              back to server-side `timings.total` for legacy renders
              (e.g. continueToVerification, where the result was
              produced earlier and we don't know the user-side time).
              The server-side breakdown is shown in Audit details
              below as the canonical engineering metric. */}
          Verified in {((clientTimings ? clientTimings.totalMs : result.timings.total) / 1000).toFixed(1)} s
          {clientTimings && (
            <>
              {" "}
              <span className="text-slate-400 dark:text-slate-500">
                (server {(result.timings.total / 1000).toFixed(1)} s)
              </span>
            </>
          )}
          {(() => {
            // Wave-35 Track 1 #2: read the server-stamped cost from
            // the response envelope (was: client-side table lookup).
            const usd = result.costUsd ?? null;
            if (usd === null) return null;
            const per1k = usd * 1000;
            // Sub-penny costs read as "$0.00025" — visually noisy and
            // misleading for a non-technical reviewer. Show the
            // friendlier per-1k figure when we're under a cent.
            const displayCost =
              usd < 0.01
                ? `≈ ${per1k < 100 ? `$${per1k.toFixed(2)}` : `$${per1k.toFixed(0)}`} per 1,000 labels`
                : `≈ $${usd.toFixed(4)} per call`;
            // The tooltip used to expose the raw model id
            // (`gemini:gemini-3.1-flash-lite`) to TTB reviewers — vendor
            // names + per-call economics read as procurement-deck stray
            // copy on a compliance verdict page (UX audit P-6). Strip
            // the model id so the user-visible tooltip only restates
            // the per-1k figure in plain English. Telemetry still has
            // the model id via /api/health and the JSON export envelope.
            return (
              <>
                {" · "}
                <span
                  title={`Approximate per-call cost. Extrapolates to ≈ $${per1k.toFixed(2)} per 1,000 labels.`}
                >
                  {displayCost}
                </span>
              </>
            );
          })()}
        </span>
      </header>

      {result.fallbackUsed && (
        <div
          role="alert"
          className="rounded-lg border-l-4 border-yellow-500 bg-yellow-50 p-3 text-sm text-yellow-900 dark:border-yellow-400 dark:bg-yellow-950/60 dark:text-yellow-200"
        >
          <span aria-hidden className="mr-1">⚠</span>
          <strong>Verified by the backup AI</strong> — primary was
          briefly unavailable. The result is still valid; re-verify in
          a moment if anything looks off.
        </div>
      )}

      <div className="grid grid-cols-1 gap-4 md:grid-cols-3">
        <div className="rounded-lg border border-slate-200 bg-white p-3 dark:border-slate-700 dark:bg-slate-900 md:col-span-1">
          {imagePreviewUrl ? (
            <ImageZoom
              src={imagePreviewUrl}
              alt="Submitted label preview"
            />
          ) : (
            <div className="flex h-48 items-center justify-center text-sm text-slate-400 dark:text-slate-500">
              No preview
            </div>
          )}
        </div>
        <div className="space-y-4 md:col-span-2">
          <div className="rounded-lg border border-slate-200 bg-white p-4 dark:border-slate-700 dark:bg-slate-900">
            <div className="flex flex-wrap items-center gap-x-6 gap-y-2">
              <div className="flex items-center gap-3">
                <span className="text-label font-medium text-slate-600 dark:text-slate-300">
                  Image quality:
                </span>
                <QualityChip quality={result.imageQuality} size="md" />
              </div>
              <div className="flex items-center gap-3">
                <span className="text-label font-medium text-slate-600 dark:text-slate-300">
                  Verdict:
                </span>
                <VerdictChip verdict={result.verdict} size="lg" />
              </div>
            </div>
            {result.imageQuality !== "good" && (
              <p className="mt-3 text-sm text-slate-600 dark:text-slate-300">
                <strong>Image quality is independent of compliance.</strong>{" "}
                {result.imageQuality === "bad"
                  ? "Re-photograph the label in better light and resubmit. This does not mean the label is non-compliant."
                  : "Some fields had low extractor confidence; consider a better photo. The compliance verdict above is separate."}
              </p>
            )}
          </div>

          <div className="space-y-2">
            <h3 className="text-label font-semibold uppercase tracking-wide text-slate-500 dark:text-slate-400">
              <span className="detailed-only">Government Warning (27 CFR §16.21)</span>
              <span className="simple-only">Government warning</span>
            </h3>
            {/* Simple-mode: collapsed one-line summary instead of the
                4-part subscore detail. Reason still surfaces below
                because it's the actionable bit on FAIL / REVIEW. */}
            <div className="simple-only rounded-lg border border-slate-200 bg-white p-3 text-sm dark:border-slate-700 dark:bg-slate-900">
              <div className="flex items-center justify-between gap-2">
                <span>Government warning check</span>
                <span className="font-semibold uppercase">
                  {gov.status === "pass"
                    ? "Pass"
                    : gov.status === "fail"
                      ? "Fail"
                      : "Needs review"}
                </span>
              </div>
              {gov.reason && (
                <p className="mt-1 text-slate-600 dark:text-slate-300">
                  {gov.reason}
                </p>
              )}
              {/* Wave-35c: non-trivial GW PASS narration. Only fires
                  when at least one subscore came in <0.95 confidence
                  (the all-high-confidence case stays unnarrated). */}
              {gov.status === "pass" && gov.passReason && (
                <p className="detailed-only mt-1 text-xs italic text-slate-500 dark:text-slate-400">
                  {gov.passReason}
                </p>
              )}
            </div>
            <div className="detailed-only rounded-lg border border-slate-200 bg-white p-4 dark:border-slate-700 dark:bg-slate-900">
              {/* Desktop (≥ sm): always-visible flat subscore list. */}
              <div className="hidden sm:block">
                <SubscoreRow
                  label="Exact text matches federal language?"
                  scoreName="Text"
                  status={gov.subscores.text.status}
                  confidence={gov.subscores.text.confidence}
                />
                <SubscoreRow
                  label="Prefix all caps?"
                  scoreName="Caps"
                  status={gov.subscores.caps.status}
                  confidence={gov.subscores.caps.confidence}
                />
                <SubscoreRow
                  label="Prefix bold (vs body)?"
                  scoreName="Bold"
                  status={gov.subscores.bold.status}
                  confidence={gov.subscores.bold.confidence}
                />
                <SubscoreRow
                  label="Type size meets §16.22 minimum?"
                  scoreName="Size"
                  status={gov.subscores.size.status}
                  confidence={gov.subscores.size.confidence}
                />
              </div>
              {/* Mobile (< sm): collapsed unless the verdict is not PASS,
                  so reviewers don't have to scroll past 4 subscore rows on
                  every result page. Per REMAINING-IMPROVEMENTS.md U1. */}
              <details
                className="sm:hidden"
                {...(gov.status !== "pass" ? { open: true } : {})}
              >
                <summary className="cursor-pointer text-sm text-slate-600 hover:text-slate-900 dark:text-slate-300 dark:hover:text-slate-100">
                  4-part subscore breakdown
                </summary>
                <div className="mt-2">
                  <SubscoreRow
                    label="Exact text matches federal language?"
                    scoreName="Text"
                    status={gov.subscores.text.status}
                    confidence={gov.subscores.text.confidence}
                  />
                  <SubscoreRow
                    label="Prefix all caps?"
                    scoreName="Caps"
                    status={gov.subscores.caps.status}
                    confidence={gov.subscores.caps.confidence}
                  />
                  <SubscoreRow
                    label="Prefix bold (vs body)?"
                    scoreName="Bold"
                    status={gov.subscores.bold.status}
                    confidence={gov.subscores.bold.confidence}
                  />
                  <SubscoreRow
                    label="Type size meets §16.22 minimum?"
                    scoreName="Size"
                    status={gov.subscores.size.status}
                    confidence={gov.subscores.size.confidence}
                  />
                </div>
              </details>
              {gov.reason && (
                <p className="mt-2 text-sm text-slate-600 dark:text-slate-300">{gov.reason}</p>
              )}
            </div>
            {/* Second-opinion panel — fires only on borderline Gov-Warning
                cases (REVIEW or no-OCR low-confidence PASS). An independent
                cross-provider vision call (GPT-5.4-nano) re-reads the
                label so the human reviewer sees what a different model
                says. Agreement = strong signal; disagreement = explicit
                "two models disagree, you decide" framing. */}
            {result.secondOpinion && (
              <div
                role="region"
                aria-label="Independent second opinion on Government Warning"
                className={`detailed-only rounded-lg border-l-4 p-3 text-sm ${
                  result.secondOpinion.agreesWithPrimary
                    ? "border-blue-500 bg-blue-50 text-blue-900 dark:border-blue-400 dark:bg-blue-950/60 dark:text-blue-200"
                    : "border-amber-500 bg-amber-50 text-amber-900 dark:border-amber-400 dark:bg-amber-950/60 dark:text-amber-200"
                }`}
              >
                <p className="font-semibold">
                  <span aria-hidden className="mr-1">
                    {result.secondOpinion.agreesWithPrimary ? "🔁" : "⚖"}
                  </span>
                  Independent second opinion on Government Warning
                </p>
                <p className="mt-1">
                  Because the primary read was borderline, we ran the same
                  label through a different model{" "}
                  <span className="font-mono text-xs">
                    ({result.secondOpinion.modelId})
                  </span>{" "}
                  for an independent verdict.
                </p>
                <p className="mt-1">
                  Second opinion:{" "}
                  <strong className="uppercase">
                    {result.secondOpinion.governmentWarning.status}
                  </strong>{" "}
                  (confidence{" "}
                  {result.secondOpinion.governmentWarning.confidence.toFixed(
                    2,
                  )}
                  ).{" "}
                  {result.secondOpinion.agreesWithPrimary ? (
                    <span>
                      <strong>Both models agree</strong> — corroborating
                      the primary verdict.
                    </span>
                  ) : (
                    <span>
                      <strong>Models disagree</strong> — a human reviewer
                      should adjudicate.
                    </span>
                  )}
                </p>
                {result.secondOpinion.governmentWarning.reason && (
                  <p className="mt-1 text-xs italic">
                    {result.secondOpinion.governmentWarning.reason}
                  </p>
                )}
              </div>
            )}
            {/* Simple-mode condensed banner: surface ONLY the
                actionable signal — a model disagreement — in one line.
                Agreement stays invisible in simple mode so the surface
                isn't cluttered with "everything is fine" reassurance. */}
            {result.secondOpinion &&
              !result.secondOpinion.agreesWithPrimary && (
                <div
                  role="alert"
                  className="simple-only rounded-md border-l-4 border-amber-500 bg-amber-50 p-3 text-sm text-amber-900 dark:border-amber-400 dark:bg-amber-950/60 dark:text-amber-200"
                >
                  <span aria-hidden className="mr-1">⚖</span>
                  We double-checked with a second AI and they disagree —
                  a human reviewer should confirm.
                </div>
              )}
          </div>

          {/* Simple-mode: only surface failing/review fields with their
              reasons. PASS fields are noise to a non-technical reviewer
              on a successful verdict. */}
          {fields.some((f) => f.status !== "pass") && (
            <div className="simple-only space-y-2">
              <h3 className="text-label font-semibold uppercase tracking-wide text-slate-500 dark:text-slate-400">
                Things to double-check
              </h3>
              <ul className="space-y-2 rounded-lg border border-slate-200 bg-white p-3 text-sm dark:border-slate-700 dark:bg-slate-900">
                {fields
                  .filter((f) => f.status !== "pass")
                  .map((f) => (
                    <li
                      key={f.field}
                      className={
                        f.status === "fail"
                          ? "text-rose-800 dark:text-rose-200"
                          : "text-amber-800 dark:text-amber-200"
                      }
                    >
                      <span className="font-medium">
                        {(FIELD_LABEL_FROM_KEY[f.field] ?? f.field) + ": "}
                      </span>
                      {f.status === "fail" ? "Failed" : "Needs review"}
                      {f.reason ? <> — {f.reason}</> : null}
                    </li>
                  ))}
              </ul>
            </div>
          )}
          <div className="detailed-only space-y-2">
            <h3 className="text-label font-semibold uppercase tracking-wide text-slate-500 dark:text-slate-400">
              Other declared fields
            </h3>
            <div className="rounded-lg border border-slate-200 bg-white dark:border-slate-700 dark:bg-slate-900">
              {fields.map((f) => (
                <FieldRow key={f.field} cmp={f} />
              ))}
            </div>
          </div>

          {/* Audit-trail expandable (wave-34 audit fix #22 + #29).
              Surfaces the regulator-defensible provenance for the
              verdict: reviewer (if set), timestamp, model id /
              version, mode, fallback, second-opinion model, and the
              full per-phase timing breakdown. Collapsed by default
              so it doesn't crowd the verdict surface, but always
              available for the audit case file. Included in the
              JSON export and printable for the PDF export. */}
          <details className="detailed-only rounded-lg border border-slate-200 bg-white p-3 text-sm dark:border-slate-700 dark:bg-slate-900">
            <summary className="cursor-pointer font-semibold text-slate-700 dark:text-slate-200">
              Audit details
            </summary>
            <dl className="mt-2 grid grid-cols-1 gap-x-6 gap-y-1 text-xs text-slate-600 dark:text-slate-300 sm:grid-cols-2">
              <div className="flex justify-between gap-3">
                <dt className="font-medium text-slate-500 dark:text-slate-400">Reviewer</dt>
                <dd className="font-mono">
                  {reviewerAtVerifyTime || (
                    <span className="text-slate-400 dark:text-slate-500">
                      (not set — use the header badge)
                    </span>
                  )}
                </dd>
              </div>
              <div className="flex justify-between gap-3">
                <dt className="font-medium text-slate-500 dark:text-slate-400">Timestamp (UTC)</dt>
                <dd className="font-mono">{verifiedAtIso}</dd>
              </div>
              <div className="flex justify-between gap-3">
                <dt className="font-medium text-slate-500 dark:text-slate-400">Primary model</dt>
                <dd className="font-mono break-all text-right">
                  {result.modelId}
                </dd>
              </div>
              <div className="flex justify-between gap-3">
                <dt className="font-medium text-slate-500 dark:text-slate-400">Model version</dt>
                <dd className="font-mono break-all text-right">
                  {result.modelVersion}
                </dd>
              </div>
              <div className="flex justify-between gap-3">
                <dt className="font-medium text-slate-500 dark:text-slate-400">Mode</dt>
                <dd className="font-mono">{result.modeUsed}</dd>
              </div>
              {result.fallbackUsed ? (
                <div className="flex justify-between gap-3">
                  <dt className="font-medium text-slate-500 dark:text-slate-400">
                    Fallback model
                  </dt>
                  <dd className="font-mono break-all text-right">
                    {result.fallbackUsed}
                  </dd>
                </div>
              ) : null}
              {result.secondOpinion ? (
                <div className="flex justify-between gap-3">
                  <dt className="font-medium text-slate-500 dark:text-slate-400">
                    Second opinion model
                  </dt>
                  <dd className="font-mono break-all text-right">
                    {result.secondOpinion.modelId}
                  </dd>
                </div>
              ) : null}
              <div className="flex justify-between gap-3">
                <dt className="font-medium text-slate-500 dark:text-slate-400">
                  Server latency (preprocess / ocr / vision / matching / total)
                </dt>
                <dd className="font-mono text-right">
                  {result.timings.preprocess} /{" "}
                  {result.timings.ocr ?? "—"} / {result.timings.vision} /{" "}
                  {result.timings.matching} / {result.timings.total} ms
                </dd>
              </div>
              {clientTimings && (
                <div className="flex justify-between gap-3">
                  <dt className="font-medium text-slate-500 dark:text-slate-400">
                    Client-perceived end-to-end (compress / network+server / total)
                  </dt>
                  <dd className="font-mono text-right">
                    {clientTimings.compressionMs} /{" "}
                    {clientTimings.networkMs} /{" "}
                    <strong>{clientTimings.totalMs}</strong> ms
                  </dd>
                </div>
              )}
              {filename ? (
                <div className="flex justify-between gap-3">
                  <dt className="font-medium text-slate-500 dark:text-slate-400">
                    Source filename
                  </dt>
                  <dd className="font-mono break-all text-right">{filename}</dd>
                </div>
              ) : null}
            </dl>
            <p className="mt-2 text-[11px] text-slate-500 dark:text-slate-400">
              Use <span className="font-semibold">Save case file (PDF)</span>{" "}
              below or <span className="font-semibold">Download JSON</span> to
              archive this entry. JSON contains the full extractor output,
              per-field comparator results, and the same audit metadata
              shown above.
            </p>
          </details>

          <div className="flex flex-wrap items-center gap-2">
            <button
              type="button"
              onClick={onAnother}
              className="min-h-[44px] rounded-md bg-slate-900 px-5 py-2.5 text-sm font-semibold text-white hover:bg-slate-700 dark:bg-blue-600 dark:hover:bg-blue-500"
            >
              Verify another label
            </button>
            {/* Save case file (PDF) — wave-34 audit fix #23. Uses
                window.print() with a dedicated `@media print`
                stylesheet (globals.css) so the browser's native
                "Save as PDF" produces a clean one-page case file
                with the image, verdict, fields, audit detail, and
                reviewer + timestamp at the foot. Available in both
                simple and detailed mode because a regulator-defensible
                case file is the whole point of the prototype. */}
            <button
              type="button"
              onClick={() => {
                // Stamp the document title so the printed PDF gets
                // a meaningful filename in Chrome/Safari/Edge.
                const stem = safeStem(filename ?? "label-verify-result");
                const prev = document.title;
                document.title = `${stem}-case-file`;
                try {
                  window.print();
                } finally {
                  // Restore after a tick so the print dialog has
                  // captured the title.
                  setTimeout(() => {
                    document.title = prev;
                  }, 500);
                }
              }}
              aria-label="Save this verification result as a printable PDF case file"
              className="min-h-[44px] rounded-md border border-slate-300 bg-white px-4 py-2 text-sm font-medium text-slate-800 hover:bg-slate-100 dark:border-slate-600 dark:bg-slate-800 dark:text-slate-100 dark:hover:bg-slate-700"
            >
              Save case file (PDF)
            </button>
            {/* Export buttons live in detailed mode only.
                Simple mode keeps the verdict + the one re-upload affordance
                visible without secondary technical actions. The data is still
                downloadable — operator just flips the mode toggle in the
                header. Per user direction 2026-05-14. */}
            <button
              type="button"
              onClick={() => {
                const stem = safeStem(filename ?? "label-verify-result");
                triggerDownload(
                  `${stem}-result.json`,
                  singleResultToJson(filename ?? stem, result, {
                    reviewer: reviewerAtVerifyTime || undefined,
                    verifiedAtIso,
                    clientTimings,
                  }),
                  "application/json",
                );
              }}
              className="detailed-only min-h-[44px] rounded-md border border-slate-300 bg-white px-4 py-2 text-sm font-medium text-slate-800 hover:bg-slate-100 dark:border-slate-600 dark:bg-slate-800 dark:text-slate-100 dark:hover:bg-slate-700"
              aria-label="Download this verification result as JSON"
            >
              Download JSON
            </button>
            <button
              type="button"
              onClick={() => {
                const stem = safeStem(filename ?? "label-verify-result");
                triggerDownload(
                  `${stem}-result.csv`,
                  singleResultToCsv(filename ?? stem, result),
                  "text/csv",
                );
              }}
              className="detailed-only min-h-[44px] rounded-md border border-slate-300 bg-white px-4 py-2 text-sm font-medium text-slate-800 hover:bg-slate-100 dark:border-slate-600 dark:bg-slate-800 dark:text-slate-100 dark:hover:bg-slate-700"
              aria-label="Download this verification result as CSV"
            >
              Download CSV
            </button>
          </div>

          {/* Visible only when printed: bottom-of-page audit footer. */}
          <div className="hidden print:block mt-6 border-t border-slate-300 pt-2 text-[10px] text-slate-600">
            Label Verify — TTB COLA verification case file ·{" "}
            Reviewer: {reviewerAtVerifyTime || "(not set)"} ·{" "}
            Verified at (UTC): {verifiedAtIso} · Primary model:{" "}
            {result.modelId} {result.modelVersion}
          </div>
        </div>
      </div>
    </section>
  );
}

function orderedFields(r: VerifyResponse): FieldComparison[] {
  const all = [
    r.fields.brand_name,
    r.fields.class_type,
    r.fields.abv_percent,
    r.fields.net_contents,
    r.fields.producer,
    r.fields.country_of_origin,
  ];
  const rank: Record<string, number> = { fail: 0, review: 1, pass: 2 };
  return all.sort((a, b) => rank[a.status]! - rank[b.status]!);
}

function FieldRow({ cmp }: { readonly cmp: FieldComparison }) {
  const borderClass =
    cmp.status === "fail"
      ? "border-l-4 border-l-red-500 dark:border-l-red-400"
      : cmp.status === "review"
        ? "border-l-4 border-l-yellow-500 dark:border-l-yellow-400"
        : "border-l-4 border-l-green-500 dark:border-l-green-400";
  return (
    <div className={`border-b border-slate-100 p-4 last:border-b-0 dark:border-slate-800 ${borderClass}`}>
      <div className="flex flex-wrap items-baseline justify-between gap-2">
        <div className="font-medium capitalize text-slate-800 dark:text-slate-100">
          {cmp.field.replace(/_/g, " ")}
        </div>
        <VerdictChip verdict={cmp.status} size="sm" />
      </div>
      <FieldValueComparison expected={cmp.expected} actual={cmp.actual} />
      {cmp.reason && (
        <p className="mt-2 text-sm text-slate-600 dark:text-slate-300">{cmp.reason}</p>
      )}
      {/* Wave-35 Track 1 #1: surface the non-trivial PASS reasoning
          (tolerance applied / fuzzy accepted / implicit-USA / country
          synonym) so a reviewer auditing a PASS understands WHY it
          wasn't FAIL. Detailed-mode only — the simple verdict surface
          stays uncluttered. Italicised + smaller font signals
          "explanatory clarification" vs the larger FAIL/REVIEW
          `reason` text above. */}
      {cmp.status === "pass" && cmp.passReason && (
        <p className="detailed-only mt-2 text-xs italic text-slate-500 dark:text-slate-400">
          {cmp.passReason}
        </p>
      )}
      {cmp.components && (
        // Auto-expand on REVIEW/FAIL so the reviewer immediately sees which
        // component (street / city / state / postal / country) failed —
        // saves a click on every non-pass and is the high-information case
        // anyway. Stays collapsed on PASS to keep the panel tight.
        <details
          className="mt-2 text-sm"
          {...(cmp.status !== "pass" ? { open: true } : {})}
        >
          <summary className="cursor-pointer text-slate-600 hover:text-slate-900 dark:text-slate-300 dark:hover:text-slate-100">
            Per-component breakdown
          </summary>
          <ul className="mt-1 space-y-0.5 pl-4 text-slate-600 dark:text-slate-300">
            {Object.entries(cmp.components).map(([k, v]) => (
              <li key={k}>
                <span className="capitalize">{k.replace(/_/g, " ")}</span>:{" "}
                <span className={statusColor(v)}>{v}</span>
              </li>
            ))}
          </ul>
        </details>
      )}
    </div>
  );
}

function SubscoreRow({
  label,
  status,
  confidence,
  scoreName,
}: {
  readonly label: string;
  readonly status: "pass" | "fail" | "review";
  readonly confidence: number;
  /** Short field name (e.g. "Text", "Caps") used to differentiate the
   *  chip's aria-label from the other three subscores on the same
   *  panel. Without this, a screen reader hears four identical
   *  "Verdict PASS" announcements. UI audit C-5. */
  readonly scoreName: string;
}) {
  return (
    <div className="flex items-center justify-between border-b border-slate-100 py-2 last:border-b-0 dark:border-slate-800">
      <span className="text-sm text-slate-800 dark:text-slate-100">{label}</span>
      <span className="flex items-center gap-2">
        {/* "conf 0.92" is jargon for a non-technical reviewer. We
            hide it on phones (<sm) and keep it visible on tablet+ for
            anyone debugging. Title attribute preserves the value for
            anyone who needs it on small screens. */}
        <span
          className="hidden text-xs text-slate-400 dark:text-slate-500 sm:inline"
          title={`Internal confidence: ${confidence.toFixed(2)}`}
        >
          conf {confidence.toFixed(2)}
        </span>
        <VerdictChip
          verdict={status}
          size="sm"
          ariaLabel={`${scoreName} subscore: ${status.toUpperCase()}`}
        />
      </span>
    </div>
  );
}

function statusColor(s: "pass" | "fail" | "review"): string {
  switch (s) {
    case "pass":
      return "text-green-700 dark:text-green-400";
    case "fail":
      return "text-red-700 dark:text-red-400";
    case "review":
      return "text-yellow-700 dark:text-yellow-400";
  }
}

/**
 * Expected ↔ Found two-column comparison. Strings / numbers / NetContents
 * render inline (compact, visually scannable). Producer-shaped objects
 * render as a stacked key/value list so the columns never collide when
 * the address wraps. JSON fallback only for truly unknown shapes — and
 * even then it uses `break-all` so it can never bleed past its column.
 */
function FieldValueComparison({
  expected,
  actual,
}: {
  readonly expected: unknown;
  readonly actual: unknown;
}) {
  const expectedIsProducer = isProducerShape(expected);
  const actualIsProducer = isProducerShape(actual);
  // Producer → vertical key/value blocks. Anything else → side-by-side
  // inline with break-all (handles long strings gracefully on mobile).
  if (expectedIsProducer || actualIsProducer) {
    return (
      <dl className="mt-2 grid grid-cols-1 gap-4 text-sm sm:grid-cols-2">
        <div>
          <dt className="text-slate-500 dark:text-slate-400">Expected</dt>
          <dd className="mt-1 font-mono text-slate-800 dark:text-slate-200">
            <ProducerBlock value={expected} />
          </dd>
        </div>
        <div>
          <dt className="text-slate-500 dark:text-slate-400">Found</dt>
          <dd className="mt-1 font-mono text-slate-800 dark:text-slate-200">
            <ProducerBlock value={actual} />
          </dd>
        </div>
      </dl>
    );
  }
  return (
    <dl className="mt-2 grid grid-cols-1 gap-x-6 gap-y-1 text-sm sm:grid-cols-2">
      <div className="min-w-0">
        <dt className="inline text-slate-500 dark:text-slate-400">Expected: </dt>
        <dd className="inline break-all font-mono text-slate-800 dark:text-slate-200">{stringify(expected)}</dd>
      </div>
      <div className="min-w-0">
        <dt className="inline text-slate-500 dark:text-slate-400">Found: </dt>
        <dd className="inline break-all font-mono text-slate-800 dark:text-slate-200">{stringify(actual)}</dd>
      </div>
    </dl>
  );
}

const PRODUCER_KEYS = [
  "name",
  "street",
  "city",
  "state",
  "postal_code",
  "country",
] as const;

function isProducerShape(v: unknown): v is Record<string, unknown> {
  if (!v || typeof v !== "object") return false;
  const keys = Object.keys(v);
  return PRODUCER_KEYS.some((k) => keys.includes(k));
}

function ProducerBlock({ value }: { readonly value: unknown }) {
  if (value == null) return <span className="text-slate-400 dark:text-slate-500">—</span>;
  if (typeof value === "string") {
    return <span className="break-words">{value}</span>;
  }
  const obj = value as Record<string, unknown>;
  return (
    <ul className="space-y-0.5">
      {PRODUCER_KEYS.map((k) => {
        const v = obj[k];
        if (v === undefined || v === null || v === "") {
          return (
            <li key={k} className="text-slate-400 dark:text-slate-500">
              <span className="text-slate-500 dark:text-slate-400">{labelFor(k)}: </span>—
            </li>
          );
        }
        return (
          <li key={k} className="break-words">
            <span className="text-slate-500 dark:text-slate-400">{labelFor(k)}: </span>
            {String(v)}
          </li>
        );
      })}
    </ul>
  );
}

function labelFor(k: string): string {
  switch (k) {
    case "postal_code":
      return "Postal code";
    case "name":
      return "Name";
    case "street":
      return "Street";
    case "city":
      return "City";
    case "state":
      return "State";
    case "country":
      return "Country";
    default:
      return k;
  }
}

function stringify(v: unknown): string {
  if (v == null) return "—";
  if (typeof v === "string") return v;
  if (typeof v === "number") return String(v);
  if (typeof v === "object") {
    // Render NetContents nicely.
    const o = v as Record<string, unknown>;
    if ("value" in o && "unit" in o) {
      return `${o.value} ${String(o.unit).replace("_", " ")}`;
    }
    return JSON.stringify(o);
  }
  return String(v);
}
