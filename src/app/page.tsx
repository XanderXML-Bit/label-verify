"use client";

import { useEffect, useState } from "react";
import type { DeclaredFields, VerifyResponse } from "@/lib/types";
import { UploadZone } from "./components/UploadZone";
import { DeclaredForm } from "./components/DeclaredForm";
import { SingleResult } from "./components/SingleResult";
import { BatchView, type BatchRow } from "./components/BatchView";
import { SampleAffordance } from "./components/SampleAffordance";
import type { Sample } from "@/lib/samples";

type Stage =
  | { kind: "idle" }
  | { kind: "single-pending"; file: File; previewUrl: string }
  | { kind: "single-verifying"; file: File; previewUrl: string }
  | { kind: "single-done"; file: File; previewUrl: string; result: VerifyResponse }
  | { kind: "single-error"; file: File; previewUrl: string; message: string }
  | { kind: "batch-pending"; files: File[] }
  | { kind: "batch-running"; batchId: string; rows: BatchRow[] };

export default function Home() {
  const [stage, setStage] = useState<Stage>({ kind: "idle" });
  const [manifestText, setManifestText] = useState("");

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
    const url = URL.createObjectURL(file);
    setStage({ kind: "single-verifying", file, previewUrl: url });
    try {
      const fd = new FormData();
      fd.append("image", file);
      fd.append("declared", JSON.stringify(sample.declared));
      const res = await fetch("/api/verify", { method: "POST", body: fd });
      if (!res.ok) {
        const err = (await res.json().catch(() => ({}))) as { error?: string };
        setStage({
          kind: "single-error",
          file,
          previewUrl: url,
          message: err.error ?? `HTTP ${res.status}`,
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
        message: (e as Error).message,
      });
    }
  }

  async function submitSingle(declared: DeclaredFields) {
    if (stage.kind !== "single-pending") return;
    setStage({ ...stage, kind: "single-verifying" });
    try {
      const fd = new FormData();
      fd.append("image", stage.file);
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
    if (stage.kind === "single-pending" || stage.kind === "single-done") {
      URL.revokeObjectURL(stage.previewUrl);
    }
    setStage({ kind: "idle" });
  }

  return (
    <div className="space-y-8">
      <header>
        <h2 className="text-2xl font-semibold tracking-tight text-slate-900">
          Verify a label against application data
        </h2>
        <p className="mt-2 max-w-2xl text-slate-600">
          Upload one label image to check it against the COLA application
          fields, or a folder of labels with a manifest spreadsheet for
          batch verification. Returns a structured pass / fail / review
          verdict in under 5 seconds.
        </p>
      </header>

      {stage.kind === "idle" && (
        <>
          <UploadZone onFiles={handleFiles} />
          <SampleAffordance onPick={handleSample} />
          <details className="rounded-lg border border-slate-200 bg-white p-4 text-sm">
            <summary className="cursor-pointer font-medium text-slate-700">
              About this prototype
            </summary>
            <div className="mt-2 space-y-2 text-slate-600">
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
        <div className="grid grid-cols-1 gap-6 lg:grid-cols-2">
          <div className="space-y-3">
            <h3 className="text-label font-semibold uppercase tracking-wide text-slate-500">
              Uploaded image
            </h3>
            {/* eslint-disable-next-line @next/next/no-img-element -- blob: URL from the user's upload, not a remote image */}
            <img
              src={stage.previewUrl}
              alt="Uploaded label preview"
              className="max-h-96 rounded-lg border border-slate-200 bg-white object-contain p-2"
            />
            <button
              type="button"
              onClick={reset}
              className="text-sm text-slate-500 underline hover:text-slate-700"
            >
              Replace image
            </button>
          </div>
          <DeclaredForm onSubmit={submitSingle} />
        </div>
      )}

      {stage.kind === "single-verifying" && (
        <div className="rounded-lg border border-slate-200 bg-white p-6">
          <p className="text-base text-slate-700" aria-live="polite">
            Checking the label… usually under 5 seconds.
          </p>
          <div className="mt-3 h-2 w-full overflow-hidden rounded bg-slate-200">
            <div className="h-full w-1/3 animate-pulse bg-blue-500" />
          </div>
        </div>
      )}

      {stage.kind === "single-done" && (
        <SingleResult
          result={stage.result}
          imagePreviewUrl={stage.previewUrl}
          onAnother={reset}
        />
      )}

      {stage.kind === "single-error" && (
        <div
          role="alert"
          aria-live="assertive"
          className="rounded-lg border border-red-300 bg-red-50 p-4 text-sm text-red-800"
        >
          <p className="font-semibold">Verification failed</p>
          <p className="mt-1">{stage.message}</p>
          <button
            type="button"
            onClick={reset}
            className="mt-3 rounded-md bg-red-700 px-4 py-2 text-white"
          >
            Try again
          </button>
        </div>
      )}

      {stage.kind === "batch-pending" && (
        <div className="space-y-4">
          <div className="rounded-lg border border-slate-200 bg-white p-4">
            <h3 className="text-lg font-semibold text-slate-800">
              Batch upload — {stage.files.length} images
            </h3>
            <p className="mt-1 text-sm text-slate-600">
              Paste a manifest (CSV or JSON) below. Required column:{" "}
              <code className="rounded bg-slate-100 px-1">filename</code>.
              Other supported columns:{" "}
              <code className="rounded bg-slate-100 px-1">brand_name</code>,{" "}
              <code className="rounded bg-slate-100 px-1">class_type</code>,{" "}
              <code className="rounded bg-slate-100 px-1">class_category</code>,{" "}
              <code className="rounded bg-slate-100 px-1">abv_percent</code>,{" "}
              <code className="rounded bg-slate-100 px-1">net_contents</code>{" "}
              (e.g. <code>12 fl_oz</code>),{" "}
              <code className="rounded bg-slate-100 px-1">producer</code>,{" "}
              <code className="rounded bg-slate-100 px-1">country_of_origin</code>.
              Filenames are paired by stem (case-insensitive).
            </p>
            <textarea
              rows={8}
              value={manifestText}
              onChange={(e) => setManifestText(e.target.value)}
              className="mt-3 w-full rounded-md border border-slate-300 px-3 py-2 font-mono text-sm focus:border-blue-500 focus:outline-none focus:ring-1 focus:ring-blue-500"
              placeholder={`filename,brand_name,class_type,class_category,abv_percent,net_contents,country_of_origin\nlabel-001.png,Stone's Throw IPA,India Pale Ale,beer,6.4,12 fl_oz,USA`}
            />
            <div className="mt-3 flex gap-3">
              <button
                type="button"
                onClick={submitBatch}
                disabled={!manifestText.trim()}
                className="rounded-md bg-blue-600 px-5 py-2 text-base font-semibold text-white hover:bg-blue-700 disabled:opacity-60"
              >
                Verify batch
              </button>
              <button
                type="button"
                onClick={reset}
                className="rounded-md border border-slate-300 px-4 py-2 text-sm text-slate-700 hover:bg-slate-100"
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
