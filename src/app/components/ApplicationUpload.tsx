"use client";

import { useId, useRef, useState } from "react";
import type { DeclaredFields } from "@/lib/types";
import type {
  ApplicationConfidence,
  ApplicationParserSource,
} from "@/lib/application/types";

// ─── ApplicationUpload ──────────────────────────────────────────────────────
//
// Accepts an application document (PDF / JSON / CSV / MD / TXT / image)
// and posts it to /api/application/parse. The parent then uses the
// returned partial DeclaredFields to prefill the editable form. The
// component is intentionally inert when no file is chosen — manual entry
// is still the fast path for a reviewer who has the seven fields in their
// head.
//
// Sources mirror the server's canonical `ApplicationParserSource` enum
// (`src/lib/application/types.ts`) so a `pdf-vision-fallback` response
// from the new PDF→vision auto-fallback path (2026-05-12) is typed
// correctly here without local-shape drift.

export interface ApplicationParsePayload {
  readonly fields: Partial<DeclaredFields>;
  readonly source: ApplicationParserSource;
  readonly warnings: readonly string[];
  readonly confidence: ApplicationConfidence;
  readonly filename: string;
}

interface Props {
  readonly onParsed: (payload: ApplicationParsePayload) => void;
  readonly disabled?: boolean;
  /**
   * Optional filename of the image being verified. When set, the
   * parser uses it to pick the matching row out of a multi-row
   * manifest (filename-keyed JSON object, `filename`-column CSV) so
   * a user who uploads a roster manifest alongside one image gets
   * the correct row's fields rather than the whole manifest flattened
   * into a single garbage record.
   */
  readonly imageFilename?: string;
}

// HEIC/HEIF intentionally excluded — sharp builds shipped with Vercel
// don't include libheif and reject them with a confusing decode error.
// Users on iOS should set Camera → Formats → "Most Compatible" or
// re-export via Photos to a JPEG.
const ACCEPT_HINT =
  ".pdf,.json,.csv,.tsv,.md,.markdown,.txt,.jpg,.jpeg,.png,.webp,application/pdf,application/json,text/csv,text/plain,text/markdown,image/jpeg,image/png,image/webp";

const REJECTED_HEIC_TYPES = new Set(["image/heic", "image/heif"]);
const REJECTED_HEIC_EXTS = [".heic", ".heif"];

const SOURCE_LABEL: Record<ApplicationParserSource, string> = {
  txt: "plain text",
  md: "markdown",
  json: "JSON",
  csv: "CSV",
  "pdf-text": "PDF text",
  "pdf-vision-fallback": "scanned PDF (vision OCR fallback)",
  docx: "DOCX",
  "image-vision": "image (AI extraction)",
};

export function ApplicationUpload({ onParsed, disabled, imageFilename }: Props) {
  const inputId = useId();
  const inputRef = useRef<HTMLInputElement | null>(null);
  const [status, setStatus] = useState<
    | { kind: "idle" }
    | { kind: "parsing"; filename: string }
    | {
        kind: "done";
        source: ApplicationParserSource;
        filename: string;
        warnings: string[];
      }
    | { kind: "error"; message: string }
  >({ kind: "idle" });

  async function handleFile(file: File): Promise<void> {
    const lowerName = file.name.toLowerCase();
    if (
      REJECTED_HEIC_TYPES.has(file.type) ||
      REJECTED_HEIC_EXTS.some((ext) => lowerName.endsWith(ext))
    ) {
      setStatus({
        kind: "error",
        message:
          "HEIC/HEIF images aren't supported by the server-side image library. Re-export the photo as JPEG or PNG (on iPhone: Settings → Camera → Formats → Most Compatible).",
      });
      return;
    }
    setStatus({ kind: "parsing", filename: file.name });
    try {
      const fd = new FormData();
      fd.append("file", file);
      // When the parent knows which image we're verifying, pass it so
      // the parser can pick the matching row out of a multi-row
      // manifest. Without this context a roster manifest dropped after
      // the image would fail to prefill correctly.
      if (imageFilename) fd.append("imageFilename", imageFilename);
      const resp = await fetch("/api/application/parse", {
        method: "POST",
        body: fd,
      });
      if (!resp.ok) {
        const body = (await resp.json().catch(() => ({}))) as {
          error?: string;
          code?: string;
        };
        setStatus({
          kind: "error",
          message: body.error ?? `HTTP ${resp.status}`,
        });
        return;
      }
      const data = (await resp.json()) as {
        fields: Partial<DeclaredFields>;
        source: ApplicationParserSource;
        warnings: string[];
        confidence: ApplicationConfidence;
      };
      setStatus({
        kind: "done",
        source: data.source,
        filename: file.name,
        warnings: data.warnings,
      });
      onParsed({
        fields: data.fields,
        source: data.source,
        warnings: data.warnings,
        confidence: data.confidence,
        filename: file.name,
      });
    } catch (err) {
      setStatus({
        kind: "error",
        message: (err as Error).message,
      });
    }
  }

  function onChange(e: React.ChangeEvent<HTMLInputElement>): void {
    const file = e.target.files?.[0];
    if (file) {
      // Allow re-uploading the same file by clearing the input.
      void handleFile(file);
      e.target.value = "";
    }
  }

  function reset(): void {
    setStatus({ kind: "idle" });
    if (inputRef.current) inputRef.current.value = "";
  }

  return (
    <div className="rounded-lg border border-dashed border-slate-300 bg-slate-50 p-4 dark:border-slate-700 dark:bg-slate-900/40">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div>
          <h3 className="text-label font-semibold uppercase tracking-wide text-slate-600 dark:text-slate-300">
            Application data (optional)
          </h3>
          <p className="mt-1 text-sm text-slate-500 dark:text-slate-400">
            Upload the COLA application as PDF, JSON, CSV, Markdown, plain
            text, or a photo of the form. We&apos;ll prefill the fields
            below — you can edit them before verifying.
          </p>
        </div>
        <div className="flex shrink-0 gap-2">
          <label
            htmlFor={inputId}
            className="inline-flex min-h-[44px] cursor-pointer items-center rounded-md border border-slate-300 bg-white px-4 py-2 text-sm font-medium text-slate-700 hover:bg-slate-100 dark:border-slate-600 dark:bg-slate-800 dark:text-slate-200 dark:hover:bg-slate-700"
          >
            {status.kind === "done" ? "Replace file" : "Choose file…"}
          </label>
          <input
            id={inputId}
            ref={inputRef}
            type="file"
            accept={ACCEPT_HINT}
            disabled={disabled || status.kind === "parsing"}
            onChange={onChange}
            className="sr-only"
          />
        </div>
      </div>

      {status.kind === "parsing" && (
        <p
          className="mt-3 text-sm text-slate-600 dark:text-slate-300"
          aria-live="polite"
        >
          Parsing <span className="font-mono">{status.filename}</span>…
        </p>
      )}

      {status.kind === "done" && (
        <div
          className="mt-3 rounded-md border border-emerald-200 bg-emerald-50 p-3 text-sm dark:border-emerald-800/60 dark:bg-emerald-950/40"
          aria-live="polite"
        >
          <p className="font-medium text-emerald-900 dark:text-emerald-200">
            Parsed <span className="font-mono">{status.filename}</span> via{" "}
            {SOURCE_LABEL[status.source]}. Review and edit the fields below
            before verifying.
          </p>
          {status.warnings.length > 0 && (
            <ul className="mt-2 list-inside list-disc text-emerald-800 dark:text-emerald-300">
              {status.warnings.map((w) => (
                <li key={w}>{w}</li>
              ))}
            </ul>
          )}
          <button
            type="button"
            onClick={reset}
            className="mt-2 text-xs underline text-emerald-700 dark:text-emerald-300"
          >
            Clear
          </button>
        </div>
      )}

      {status.kind === "error" && (
        <div
          className="mt-3 rounded-md border border-red-300 bg-red-50 p-3 text-sm text-red-800 dark:border-red-700 dark:bg-red-950/60 dark:text-red-200"
          role="alert"
          aria-live="assertive"
        >
          <p className="font-medium">Application parse failed</p>
          <p className="mt-0.5">{status.message}</p>
          <button
            type="button"
            onClick={reset}
            className="mt-2 text-xs underline"
          >
            Try a different file
          </button>
        </div>
      )}
    </div>
  );
}
