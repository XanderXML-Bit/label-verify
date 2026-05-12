"use client";

import { useEffect, useState } from "react";
import type { DeclaredFields, VerifyResponse } from "@/lib/types";
import type { ExtractOnlyResponse } from "@/lib/verify";
import { UploadZone } from "./components/UploadZone";
import { DeclaredForm } from "./components/DeclaredForm";
import { SingleResult } from "./components/SingleResult";
import { ExtractionOnlyResult } from "./components/ExtractionOnlyResult";
import { VerifyProgress } from "./components/VerifyProgress";
import { ApiStatusBanner } from "./components/ApiStatusBanner";
import { BatchView, type BatchRow } from "./components/BatchView";
import { SampleAffordance } from "./components/SampleAffordance";
import { ReviewQueuePanel } from "./components/ReviewQueuePanel";
import {
  ApplicationUpload,
  type ApplicationParsePayload,
} from "./components/ApplicationUpload";
import type { Sample } from "@/lib/samples";
import { compressImageInBrowser } from "@/lib/client-compress";

// Translate raw API error strings into plain-language copy a senior
// reviewer can act on. The raw `HTTP 503` / `FUNCTION_INVOCATION_
// TIMEOUT` strings are noise to a non-technical user.
function friendlyError(raw: string, status?: number): string {
  if (status === 429) {
    return "We've hit the per-minute request limit. Wait a moment and try again.";
  }
  if (status === 413) {
    return "That image is too large. Try a smaller file (under 10 MB) or compress it before uploading.";
  }
  if (status === 415) {
    return "That file type isn't supported. Use a JPEG, PNG, WebP, or PDF.";
  }
  if (status === 504 || /timeout|TIMEOUT/.test(raw)) {
    return "The verification took too long to respond. The service may be cold-starting — try again in a few seconds.";
  }
  if (status === 503 || /UNAVAILABLE|configuration/.test(raw)) {
    return "The verification service is unavailable right now. Try again in a few minutes; if it keeps failing, the operator may need to refresh the API key.";
  }
  if (status === 500) {
    return "Something went wrong on our side. Try again — if it keeps happening, take a screenshot and let the team know.";
  }
  return raw;
}

type Stage =
  | { kind: "idle" }
  | { kind: "single-pending"; file: File; previewUrl: string }
  | { kind: "single-verifying"; file: File; previewUrl: string }
  | { kind: "single-extracting"; file: File; previewUrl: string }
  | { kind: "single-done"; file: File; previewUrl: string; result: VerifyResponse }
  | {
      kind: "single-extract-done";
      file: File;
      previewUrl: string;
      result: ExtractOnlyResponse;
    }
  | {
      kind: "single-error";
      file: File;
      previewUrl: string;
      message: string;
      /** Set when the failed flow originated from a sample button — lets
       *  the UI offer a "retry this sample" affordance instead of the
       *  generic "Try again" that just dumps the user back to idle. */
      retrySample?: Sample;
    }
  | { kind: "batch-pending"; files: File[] }
  | { kind: "batch-running"; batchId: string; rows: BatchRow[] };

export default function Home() {
  const [stage, setStage] = useState<Stage>({ kind: "idle" });
  const [manifestText, setManifestText] = useState("");
  // Parsed application payload, used to prefill DeclaredForm. The
  // monotonic `version` counter is appended to the form key so the
  // controlled inputs re-initialise when a new file lands.
  const [appPrefill, setAppPrefill] = useState<{
    fields: ApplicationParsePayload["fields"];
    source: ApplicationParsePayload["source"];
    filename: string;
    version: number;
  } | null>(null);

  // Warm the function + Tesseract worker on page load (DEPLOYMENT.md §6).
  useEffect(() => {
    fetch("/api/warmup").catch(() => undefined);
  }, []);

  function handleFiles(files: File[]) {
    if (files.length === 1) {
      const f = files[0]!;
      const url = URL.createObjectURL(f);
      setStage({ kind: "single-pending", file: f, previewUrl: url });
    } else if (files.length > 1) {
      setStage({ kind: "batch-pending", files });
    }
  }

  async function handleSample(sample: Sample, file: File) {
    // Sample affordance: skip the form and verify immediately so the
    // reviewer sees an end-to-end result in one click (UI-SPEC.md §4).
    // Tracks the originating sample on `single-error` so a runtime
    // failure offers a "retry this sample" affordance instead of
    // dumping the user back to idle.
    const url = URL.createObjectURL(file);
    setStage({ kind: "single-verifying", file, previewUrl: url });
    try {
      const uploadFile = await compressImageInBrowser(file);
      const fd = new FormData();
      fd.append("image", uploadFile);
      fd.append("declared", JSON.stringify(sample.declared));
      const res = await fetch("/api/verify", { method: "POST", body: fd });
      if (!res.ok) {
        const err = (await res.json().catch(() => ({}))) as { error?: string };
        setStage({
          kind: "single-error",
          file,
          previewUrl: url,
          message: friendlyError(err.error ?? `HTTP ${res.status}`, res.status),
          retrySample: sample,
        });
        return;
      }
      const result = (await res.json()) as VerifyResponse;
      setStage({ kind: "single-done", file, previewUrl: url, result });
    } catch (e) {
      setStage({
        kind: "single-error",
        file,
        previewUrl: url,
        retrySample: sample,
        message: (e as Error).message,
      });
    }
  }

  async function submitSingle(declared: DeclaredFields) {
    if (stage.kind !== "single-pending") return;
    setStage({ ...stage, kind: "single-verifying" });
    try {
      // Compress in the browser before upload. Cuts a 4–8 MB phone photo
      // to ~250–500 KB and shaves multi-second uploads on cellular.
      const uploadFile = await compressImageInBrowser(stage.file);
      const fd = new FormData();
      fd.append("image", uploadFile);
      fd.append("declared", JSON.stringify(declared));
      const res = await fetch("/api/verify", { method: "POST", body: fd });
      if (!res.ok) {
        const err = (await res.json().catch(() => ({}))) as { error?: string };
        setStage({
          kind: "single-error",
          file: stage.file,
          previewUrl: stage.previewUrl,
          message: err.error ?? `HTTP ${res.status}`,
        });
        return;
      }
      const result = (await res.json()) as VerifyResponse;
      setStage({
        kind: "single-done",
        file: stage.file,
        previewUrl: stage.previewUrl,
        result,
      });
    } catch (e) {
      setStage({
        kind: "single-error",
        file: stage.file,
        previewUrl: stage.previewUrl,
        message: (e as Error).message,
      });
    }
  }

  async function submitExtractOnly() {
    if (stage.kind !== "single-pending") return;
    setStage({ ...stage, kind: "single-extracting" });
    try {
      const uploadFile = await compressImageInBrowser(stage.file);
      const fd = new FormData();
      fd.append("image", uploadFile);
      const res = await fetch("/api/extract", { method: "POST", body: fd });
      if (!res.ok) {
        const err = (await res.json().catch(() => ({}))) as { error?: string };
        setStage({
          kind: "single-error",
          file: stage.file,
          previewUrl: stage.previewUrl,
          message: err.error ?? `HTTP ${res.status}`,
        });
        return;
      }
      const result = (await res.json()) as ExtractOnlyResponse;
      setStage({
        kind: "single-extract-done",
        file: stage.file,
        previewUrl: stage.previewUrl,
        result,
      });
    } catch (e) {
      setStage({
        kind: "single-error",
        file: stage.file,
        previewUrl: stage.previewUrl,
        message: (e as Error).message,
      });
    }
  }

  async function submitBatch() {
    if (stage.kind !== "batch-pending") return;
    const fd = new FormData();
    fd.append("manifest", manifestText);
    for (const f of stage.files) fd.append(f.name, f);
    const res = await fetch("/api/verify/batch", { method: "POST", body: fd });
    if (!res.ok) {
      const err = (await res.json().catch(() => ({}))) as { error?: string };
      alert(`Batch upload failed: ${err.error ?? `HTTP ${res.status}`}`);
      return;
    }
    const body = (await res.json()) as {
      batchId: string;
      count: number;
      pairingErrors?: string[];
    };
    const rows: BatchRow[] = Array.from({ length: body.count }, (_, i) => ({
      index: i,
      filename: stage.files[i]?.name ?? `item-${i}`,
      status: "pending" as const,
    }));
    setStage({ kind: "batch-running", batchId: body.batchId, rows });
  }

  function reset() {
    if (
      stage.kind === "single-pending" ||
      stage.kind === "single-done" ||
      stage.kind === "single-extract-done"
    ) {
      URL.revokeObjectURL(stage.previewUrl);
    }
    setStage({ kind: "idle" });
    setAppPrefill(null);
  }

  function handleApplicationParsed(payload: ApplicationParsePayload) {
    setAppPrefill((prev) => ({
      fields: payload.fields,
      source: payload.source,
      filename: payload.filename,
      version: (prev?.version ?? 0) + 1,
    }));
  }

  return (
    <div className="space-y-8">
      <ApiStatusBanner />
      <header>
        <h2 className="text-2xl font-semibold tracking-tight text-slate-900 dark:text-slate-100">
          Verify a label against application data
        </h2>
        <p className="mt-2 max-w-2xl text-slate-600 dark:text-slate-300">
          Upload a label image, then add the COLA application data (PDF,
          JSON, CSV, Markdown, text, or a photo of the form) — or fill
          the fields in manually. Returns a pass / fail / review verdict
          in seconds.
        </p>
      </header>

      {stage.kind === "idle" && (
        <>
          <UploadZone onFiles={handleFiles} />
          <SampleAffordance onPick={handleSample} />
          {/* Mode picker removed 2026-05-12: the bake-off
              (docs/MODEL-SELECTION.md §4) showed three of the five
              previously-offered modes were strictly worse than the
              default on this corpus. Offering them mis-leads
              non-technical reviewers. Underlying model-modes catalogue
              + /api/verify?mode= parameter retained for the benchmark
              harness and operator A/B testing. */}
          <ReviewQueuePanel />
          <details className="rounded-lg border border-slate-200 bg-white p-4 text-sm dark:border-slate-700 dark:bg-slate-900">
            <summary className="cursor-pointer font-medium text-slate-700 dark:text-slate-200">
              About this prototype
            </summary>
            <div className="mt-2 space-y-2 text-slate-600 dark:text-slate-300">
              <p>
                Verifies seven regulated fields per 27 CFR §16.21 / §16.22
                (Government Warning text, prefix all-caps, prefix bold,
                type-size minimum) and the COLA-declared fields (brand,
                class/type, ABV, net contents, producer, country).
              </p>
              <p>
                The Image Quality and Verdict columns are independent: a
                FAIL on image quality does not count as a non-compliant
                label.
              </p>
            </div>
          </details>
        </>
      )}

      {stage.kind === "single-pending" && (
        <div className="space-y-6">
          <ApplicationUpload onParsed={handleApplicationParsed} />
          <div className="grid grid-cols-1 gap-6 md:grid-cols-2">
            <div className="space-y-3">
              <h3 className="text-label font-semibold uppercase tracking-wide text-slate-500 dark:text-slate-400">
                Uploaded image
              </h3>
              {/* eslint-disable-next-line @next/next/no-img-element -- blob: URL from the user's upload, not a remote image */}
              <img
                src={stage.previewUrl}
                alt="Uploaded label preview"
                loading="lazy"
                decoding="async"
                className="max-h-96 w-full rounded-lg border border-slate-200 bg-white object-contain p-2 dark:border-slate-700 dark:bg-slate-900"
              />
              <button
                type="button"
                onClick={reset}
                className="rounded px-1 py-0.5 text-sm text-slate-500 underline hover:text-slate-700 dark:text-slate-400 dark:hover:text-slate-200"
              >
                Replace image
              </button>
            </div>
            <DeclaredForm
              // Re-mount when a new application file is parsed so the
              // controlled inputs pick up the prefilled values via `initial`.
              // Without the key bump the inputs stay on whatever the user
              // last typed and silently swallow the new application data.
              key={appPrefill ? `prefill-${appPrefill.version}` : "manual"}
              onSubmit={submitSingle}
              initial={appPrefill?.fields}
              onExtractOnly={submitExtractOnly}
            />
          </div>
        </div>
      )}

      {(stage.kind === "single-verifying" ||
        stage.kind === "single-extracting") && (
        <VerifyProgress
          verb={
            stage.kind === "single-verifying"
              ? "Checking the label"
              : "Extracting from the label"
          }
        />
      )}

      {stage.kind === "single-done" && (
        <SingleResult
          result={stage.result}
          imagePreviewUrl={stage.previewUrl}
          onAnother={reset}
        />
      )}

      {stage.kind === "single-extract-done" && (
        <ExtractionOnlyResult
          result={stage.result}
          imagePreviewUrl={stage.previewUrl}
          onAnother={reset}
        />
      )}

      {stage.kind === "single-error" && (
        <div
          role="alert"
          aria-live="assertive"
          className="rounded-lg border border-red-300 bg-red-50 p-4 text-sm text-red-800 dark:border-red-700 dark:bg-red-950 dark:text-red-200"
        >
          <h2 className="text-base font-semibold">Verification failed</h2>
          <p className="mt-1">{stage.message}</p>
          <div className="mt-3 flex flex-wrap gap-2">
            {stage.retrySample && (
              <button
                type="button"
                onClick={() => {
                  const sample = stage.retrySample!;
                  void handleSample(sample, stage.file);
                }}
                className="min-h-[44px] rounded-md bg-red-700 px-4 py-2.5 font-semibold text-white hover:bg-red-800 dark:bg-red-600 dark:hover:bg-red-500"
              >
                Retry this sample
              </button>
            )}
            <button
              type="button"
              onClick={reset}
              className="min-h-[44px] rounded-md border border-red-300 bg-white px-4 py-2.5 font-semibold text-red-700 hover:bg-red-50 dark:border-red-700 dark:bg-red-950 dark:text-red-200 dark:hover:bg-red-900"
            >
              {stage.retrySample ? "Start over" : "Try again"}
            </button>
          </div>
        </div>
      )}

      {stage.kind === "batch-pending" && (
        <div className="space-y-4">
          <div className="rounded-lg border border-slate-200 bg-white p-4 dark:border-slate-700 dark:bg-slate-900">
            <h3 className="text-lg font-semibold text-slate-800 dark:text-slate-100">
              Batch upload — {stage.files.length} images
            </h3>
            <p className="mt-1 text-sm text-slate-600 dark:text-slate-300">
              Paste a manifest (CSV or JSON) below. Required column:{" "}
              <code className="rounded bg-slate-100 px-1 dark:bg-slate-800 dark:text-slate-200">filename</code>.
              Other supported columns:{" "}
              <code className="rounded bg-slate-100 px-1 dark:bg-slate-800 dark:text-slate-200">brand_name</code>,{" "}
              <code className="rounded bg-slate-100 px-1 dark:bg-slate-800 dark:text-slate-200">class_type</code>,{" "}
              <code className="rounded bg-slate-100 px-1 dark:bg-slate-800 dark:text-slate-200">class_category</code>,{" "}
              <code className="rounded bg-slate-100 px-1 dark:bg-slate-800 dark:text-slate-200">abv_percent</code>,{" "}
              <code className="rounded bg-slate-100 px-1 dark:bg-slate-800 dark:text-slate-200">net_contents</code>{" "}
              (e.g. <code className="dark:text-slate-200">12 fl_oz</code>),{" "}
              <code className="rounded bg-slate-100 px-1 dark:bg-slate-800 dark:text-slate-200">producer</code>,{" "}
              <code className="rounded bg-slate-100 px-1 dark:bg-slate-800 dark:text-slate-200">country_of_origin</code>.
              Filenames are paired by stem (case-insensitive).
            </p>
            <textarea
              rows={8}
              value={manifestText}
              onChange={(e) => setManifestText(e.target.value)}
              aria-label="Batch manifest (CSV or JSON)"
              className="mt-3 w-full rounded-md border border-slate-300 bg-white px-3 py-2 font-mono text-sm text-slate-900 placeholder-slate-400 focus:border-blue-500 focus:outline-none focus:ring-1 focus:ring-blue-500 dark:border-slate-600 dark:bg-slate-800 dark:text-slate-100 dark:placeholder-slate-500 dark:focus:border-blue-400 dark:focus:ring-blue-400"
              placeholder={`filename,brand_name,class_type,class_category,abv_percent,net_contents,country_of_origin\nlabel-001.png,Stone's Throw IPA,India Pale Ale,beer,6.4,12 fl_oz,USA`}
            />
            <div className="mt-3 flex flex-wrap gap-3">
              <button
                type="button"
                onClick={submitBatch}
                disabled={!manifestText.trim()}
                className="min-h-[44px] rounded-md bg-blue-600 px-5 py-2.5 text-base font-semibold text-white hover:bg-blue-700 disabled:cursor-not-allowed disabled:opacity-60 dark:bg-blue-500 dark:hover:bg-blue-400"
              >
                Verify batch
              </button>
              <button
                type="button"
                onClick={reset}
                className="min-h-[44px] rounded-md border border-slate-300 px-4 py-2.5 text-sm text-slate-700 hover:bg-slate-100 dark:border-slate-600 dark:text-slate-200 dark:hover:bg-slate-800"
              >
                Cancel
              </button>
            </div>
          </div>
        </div>
      )}

      {stage.kind === "batch-running" && (
        <BatchView
          batchId={stage.batchId}
          rows={stage.rows}
          onDone={() => undefined}
        />
      )}
    </div>
  );
}
