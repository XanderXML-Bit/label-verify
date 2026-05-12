"use client";

import type { ExtractedFields, NetContents, ProducerAddress } from "@/lib/vision/types";
import type { GovernmentWarningCheck } from "@/lib/validation/government-warning";
import { QualityChip, VerdictChip } from "./StatusChip";

// ─── ExtractionOnlyResult ──────────────────────────────────────────────────
//
// Renders /api/extract responses for the "I only have a label, no
// application data" flow. Visually mirrors SingleResult but does NOT
// render PASS / FAIL / REVIEW field comparisons (we have nothing to
// compare against). The yellow disclaimer up top is the load-bearing
// piece — the reviewer must NOT mistake this for a verification.
//
// The Government Warning subscore IS shown — that's a federal
// regulation check (27 CFR §16.21), independent of application data, so
// it's still meaningful here.

const MODE_LABEL: Record<string, string> = {
  default: "Default",
  fast: "Fast",
  smart: "Smart",
  local: "Local",
  balanced: "Balanced",
};

interface Props {
  readonly result: {
    extracted: ExtractedFields;
    imageQuality: "good" | "low" | "bad";
    imageQualityReason?: string;
    governmentWarning: GovernmentWarningCheck;
    timings: {
      preprocess: number;
      ocr: number | null;
      vision: number;
      matching: number;
      total: number;
    };
    modelId: string;
    modelVersion: string;
    modeUsed: string;
    note: string;
  };
  readonly imagePreviewUrl: string;
  readonly onAnother: () => void;
}

export function ExtractionOnlyResult({
  result,
  imagePreviewUrl,
  onAnother,
}: Props) {
  const { extracted, governmentWarning: gov } = result;
  const modeLabel = MODE_LABEL[result.modeUsed] ?? result.modeUsed;
  const formatField = (v: unknown): string => {
    if (v == null) return "(not detected)";
    if (typeof v === "string") return v || "(empty)";
    if (typeof v === "number") return String(v);
    if (typeof v === "object") {
      const nc = v as Partial<NetContents>;
      if ("value" in nc && "unit" in nc) {
        return `${nc.value} ${nc.unit}`;
      }
      const p = v as Partial<ProducerAddress>;
      if ("name" in p) {
        return [p.name, p.street, p.city, p.state, p.postal_code, p.country]
          .filter(Boolean)
          .join(", ") || "(empty)";
      }
      return JSON.stringify(v);
    }
    return String(v);
  };

  return (
    <section
      aria-labelledby="extract-results-heading"
      className="space-y-6"
    >
      <header className="flex flex-wrap items-center justify-between gap-3">
        <h2
          id="extract-results-heading"
          className="text-xl font-semibold text-slate-800 dark:text-slate-100"
        >
          Extracted from label
        </h2>
        <span
          className="text-sm text-slate-500 dark:text-slate-400"
          aria-live="polite"
        >
          Extracted in {(result.timings.total / 1000).toFixed(1)} s
        </span>
      </header>

      {/* The disclaimer banner is the most important element on the page:
          it stops a reviewer from treating extracted text as a verified
          comparison. Yellow + alert role + non-dismissible. */}
      <div
        role="alert"
        className="rounded-lg border-l-4 border-yellow-500 bg-yellow-50 p-4 text-sm text-yellow-900 dark:border-yellow-400 dark:bg-yellow-950/60 dark:text-yellow-200"
      >
        <p className="text-base font-semibold">
          <span aria-hidden className="mr-1">
            ⚠
          </span>
          This is not a compliance verdict — extraction only
        </p>
        <p className="mt-1">{result.note}</p>
      </div>

      <div className="grid grid-cols-1 gap-4 md:grid-cols-3">
        <div className="rounded-lg border border-slate-200 bg-white p-3 dark:border-slate-700 dark:bg-slate-900 md:col-span-1">
          {imagePreviewUrl ? (
            // eslint-disable-next-line @next/next/no-img-element -- blob: URL from the user's upload, not a remote image
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
            </div>
            <p className="mt-2 text-xs text-slate-500 dark:text-slate-400">
              Extracted using: <strong className="font-medium">{modeLabel}</strong>
            </p>
            {result.imageQuality !== "good" && result.imageQualityReason && (
              <p className="mt-3 text-sm text-slate-600 dark:text-slate-300">
                {result.imageQualityReason}
              </p>
            )}
          </div>

          <div className="space-y-2">
            <h3 className="text-label font-semibold uppercase tracking-wide text-slate-500 dark:text-slate-400">
              Government Warning (27 CFR §16.21)
            </h3>
            <p className="text-xs text-slate-500 dark:text-slate-400">
              Self-contained check — federal regulation, doesn&apos;t need
              the application.
            </p>
            <div className="rounded-lg border border-slate-200 bg-white p-4 dark:border-slate-700 dark:bg-slate-900">
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
              {gov.reason && (
                <p className="mt-2 text-sm text-slate-600 dark:text-slate-300">
                  {gov.reason}
                </p>
              )}
            </div>
          </div>

          <div className="space-y-2">
            <h3 className="text-label font-semibold uppercase tracking-wide text-slate-500 dark:text-slate-400">
              Extracted fields (for reference)
            </h3>
            <div className="rounded-lg border border-slate-200 bg-white dark:border-slate-700 dark:bg-slate-900">
              <ExtractedRow
                name="Brand name"
                value={formatField(extracted.brand_name.value)}
                confidence={extracted.brand_name.confidence}
              />
              <ExtractedRow
                name="Class / type"
                value={formatField(extracted.class_type.value)}
                confidence={extracted.class_type.confidence}
              />
              <ExtractedRow
                name="ABV (%)"
                value={formatField(extracted.abv_percent.value)}
                confidence={extracted.abv_percent.confidence}
              />
              <ExtractedRow
                name="Net contents"
                value={formatField(extracted.net_contents.value)}
                confidence={extracted.net_contents.confidence}
              />
              <ExtractedRow
                name="Producer"
                value={formatField(extracted.producer.value)}
                confidence={extracted.producer.confidence}
              />
              <ExtractedRow
                name="Country of origin"
                value={formatField(extracted.country_of_origin.value)}
                confidence={extracted.country_of_origin.confidence}
              />
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
        <span className="text-xs text-slate-400 dark:text-slate-500">
          conf {confidence.toFixed(2)}
        </span>
        <VerdictChip verdict={status} size="sm" />
      </span>
    </div>
  );
}

function ExtractedRow({
  name,
  value,
  confidence,
}: {
  readonly name: string;
  readonly value: string;
  readonly confidence: number;
}) {
  return (
    <div className="border-b border-slate-100 p-4 last:border-b-0 dark:border-slate-800">
      <div className="flex flex-wrap items-baseline justify-between gap-2">
        <div className="font-medium text-slate-800 dark:text-slate-100">{name}</div>
        <span className="text-xs text-slate-400 dark:text-slate-500">
          conf {confidence.toFixed(2)}
        </span>
      </div>
      <p className="mt-1 text-sm text-slate-600 dark:text-slate-300">
        {value}
      </p>
    </div>
  );
}
