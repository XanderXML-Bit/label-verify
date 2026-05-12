"use client";

import { useMemo } from "react";
import type { VerifyResponse } from "@/lib/types";
import type { FieldComparison } from "@/lib/matching";
import { VerdictChip, QualityChip } from "./StatusChip";

// Approximate cost-per-call by model id, in USD. Refreshed from
// `benchmarks/results/<latest>.md` columns "USD / call". Surfaced on
// the result panel so a TTB ops viewer sees the order-of-magnitude
// economics of a single verify alongside the latency — useful for
// procurement conversations ("cost / 1k labels" = call × 1000).
// REMAINING-IMPROVEMENTS.md U6.
const COST_PER_CALL_BY_MODEL: Record<string, number> = {
  "gemini:gemini-3.1-flash-lite": 0.00025,
  "gemini:gemini-3-flash-preview": 0.00243,
  "gemini:gemini-3.1-pro-preview": 0.00345,
  "openai:gpt-5.4-nano": 0.00125,
  "openai:gpt-4o-mini": 0.00045,
};

function approximateCostUsd(modelId: string | undefined): number | null {
  if (!modelId) return null;
  const direct = COST_PER_CALL_BY_MODEL[modelId];
  if (typeof direct === "number") return direct;
  // Best-effort prefix match: "gemini:..." → gemini lite default.
  if (modelId.startsWith("gemini:")) return 0.00025;
  if (modelId.startsWith("openai:")) return 0.00125;
  return null;
}

// Display labels for the model modes the verifier may return.
// Mirrors @/lib/model-modes#MODES but is kept inline so this client
// browser bundle.

interface SingleResultProps {
  readonly result: VerifyResponse;
  readonly imagePreviewUrl: string;
  readonly onAnother: () => void;
}

export function SingleResult({
  result,
  imagePreviewUrl,
  onAnother,
}: SingleResultProps) {
  // Sort fields: failures first, then review, then pass. The bordered
  // emphasis on FAIL rows comes from `FieldRow` below.
  const fields = useMemo(() => orderedFields(result), [result]);
  const gov = result.governmentWarning;

  return (
    <section aria-labelledby="results-heading" className="space-y-6">
      <header className="flex flex-wrap items-center justify-between gap-3">
        <h2 id="results-heading" className="text-xl font-semibold text-slate-800 dark:text-slate-100">
          Verification result
        </h2>
        <span className="text-sm text-slate-500 dark:text-slate-400" aria-live="polite">
          Verified in {(result.timings.total / 1000).toFixed(1)} s
          {(() => {
            const usd = approximateCostUsd(result.modelId);
            if (usd === null) return null;
            const per1k = usd * 1000;
            // Sub-penny costs read as "$0.00025" — visually noisy and
            // misleading for a non-technical reviewer. Show the
            // friendlier per-1k figure when we're under a cent.
            const displayCost =
              usd < 0.01
                ? `≈ ${per1k < 100 ? `$${per1k.toFixed(2)}` : `$${per1k.toFixed(0)}`} per 1,000 labels`
                : `≈ $${usd.toFixed(4)} per call`;
            return (
              <>
                {" · "}
                <span
                  title={`Approximate per-call cost from ${result.modelId}. Extrapolates to ≈ $${per1k.toFixed(2)} per 1,000 labels.`}
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
          <p className="font-semibold">
            <span aria-hidden className="mr-1">⚠</span>
            We used a backup verifier for this one
          </p>
          <p className="mt-1">
            Our main AI service was briefly unavailable, so a backup
            took over. The result below is still trustworthy, but if
            anything looks off you can verify the label again in a
            minute or two when the main service is back.
          </p>
        </div>
      )}

      <div className="grid grid-cols-1 gap-4 md:grid-cols-3">
        <div className="rounded-lg border border-slate-200 bg-white p-3 dark:border-slate-700 dark:bg-slate-900 md:col-span-1">
          {imagePreviewUrl ? (
            /* eslint-disable-next-line @next/next/no-img-element -- blob: URL from the user's upload, not a remote image */
            <img
              src={imagePreviewUrl}
              alt="Submitted label preview"
              loading="lazy"
              decoding="async"
              className="h-full max-h-96 w-full rounded-md object-contain"
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
              Government Warning (27 CFR §16.21)
            </h3>
            <div className="rounded-lg border border-slate-200 bg-white p-4 dark:border-slate-700 dark:bg-slate-900">
              {/* Desktop (≥ sm): always-visible flat subscore list. */}
              <div className="hidden sm:block">
                <SubscoreRow
                  label="Exact text matches federal language?"
                  status={gov.subscores.text.status}
                  confidence={gov.subscores.text.confidence}
                />
                <SubscoreRow
                  label="Prefix all caps?"
                  status={gov.subscores.caps.status}
                  confidence={gov.subscores.caps.confidence}
                />
                <SubscoreRow
                  label="Prefix bold (vs body)?"
                  status={gov.subscores.bold.status}
                  confidence={gov.subscores.bold.confidence}
                />
                <SubscoreRow
                  label="Type size meets §16.22 minimum?"
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
                    status={gov.subscores.text.status}
                    confidence={gov.subscores.text.confidence}
                  />
                  <SubscoreRow
                    label="Prefix all caps?"
                    status={gov.subscores.caps.status}
                    confidence={gov.subscores.caps.confidence}
                  />
                  <SubscoreRow
                    label="Prefix bold (vs body)?"
                    status={gov.subscores.bold.status}
                    confidence={gov.subscores.bold.confidence}
                  />
                  <SubscoreRow
                    label="Type size meets §16.22 minimum?"
                    status={gov.subscores.size.status}
                    confidence={gov.subscores.size.confidence}
                  />
                </div>
              </details>
              {gov.reason && (
                <p className="mt-2 text-sm text-slate-600 dark:text-slate-300">{gov.reason}</p>
              )}
            </div>
          </div>

          <div className="space-y-2">
            <h3 className="text-label font-semibold uppercase tracking-wide text-slate-500 dark:text-slate-400">
              Other declared fields
            </h3>
            <div className="rounded-lg border border-slate-200 bg-white dark:border-slate-700 dark:bg-slate-900">
              {fields.map((f) => (
                <FieldRow key={f.field} cmp={f} />
              ))}
            </div>
          </div>

          <button
            type="button"
            onClick={onAnother}
            className="min-h-[44px] rounded-md bg-slate-900 px-5 py-2.5 text-sm font-semibold text-white hover:bg-slate-700 dark:bg-blue-600 dark:hover:bg-blue-500"
          >
            Verify another label
          </button>
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
}: {
  readonly label: string;
  readonly status: "pass" | "fail" | "review";
  readonly confidence: number;
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
        <VerdictChip verdict={status} size="sm" />
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
