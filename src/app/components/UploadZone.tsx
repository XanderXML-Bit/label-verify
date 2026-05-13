"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { isLikelyIos } from "@/lib/upload-merge";

interface UploadZoneProps {
  readonly onFiles: (files: File[]) => void;
  readonly accept?: string[];
  readonly multiple?: boolean;
  readonly disabled?: boolean;
  /**
   * Visual mode for the dropzone:
   *  - "replace" (default): the standard idle-screen dropzone. Copy
   *    invites the reviewer to drop a label image.
   *  - "append": rendered underneath an already-staged image / batch
   *    summary. Copy is tightened to "Add more files" with an
   *    explicit iOS hint, and the dropzone is visually de-emphasised
   *    (smaller, lighter chrome). The parent is responsible for
   *    merging the resulting `onFiles(files)` callback into its
   *    existing staged set via mergeFilesForRestage.
   *
   * The behaviour of the underlying <input> is identical in both
   * modes — the difference is purely UI/UX copy so users on iOS,
   * who often have to pick photos one-at-a-time, understand that
   * subsequent picker actions accumulate rather than replace.
   */
  readonly mode?: "replace" | "append";
}

// Extension → MIME fallback table for the cases where the browser
// reports `f.type === ""`. Windows Explorer routinely does this for
// `.csv`, `.md`, `.heic`, and `.docx` (especially on Edge/Win11), so
// the previous strict `accept.includes(f.type)` check rejected files
// that the OS picker had just shown to the user. UI audit blocker #3.
// Module-scope const so React-hooks/exhaustive-deps doesn't complain
// about a moving reference inside the filterAccepted useCallback.
const EXT_TO_MIME: Record<string, string> = {
  jpg: "image/jpeg",
  jpeg: "image/jpeg",
  png: "image/png",
  webp: "image/webp",
  heic: "image/heic",
  heif: "image/heif",
  pdf: "application/pdf",
  json: "application/json",
  csv: "text/csv",
  md: "text/markdown",
  markdown: "text/markdown",
  txt: "text/plain",
  docx: "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
};

// The unified dropzone accepts both label images (the gating input)
// and application documents (PDF/JSON/CSV/MD/TXT). Intent inference
// in page.tsx → handleFiles decides the flow per the drop's contents:
// 1 image → single; 1 image + 1 app → single + pre-fill;
// ≥ 2 images → batch (with auto-pair if apps were also dropped).
const DEFAULT_ACCEPT = [
  // Label images.
  "image/jpeg",
  "image/png",
  "image/webp",
  "image/heic",
  "image/heif",
  // Application documents.
  "application/pdf",
  "application/json",
  "text/json",
  "text/csv",
  "application/csv",
  "text/markdown",
  "text/x-markdown",
  "text/plain",
  "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
];

export function UploadZone({
  onFiles,
  accept = DEFAULT_ACCEPT,
  multiple = true,
  disabled = false,
  mode = "replace",
}: UploadZoneProps) {
  const [dragOver, setDragOver] = useState(false);
  // Detect iOS only once after mount — `isLikelyIos()` touches
  // `navigator`, which is undefined on the server, so the check is
  // deferred to a `useEffect`. Initial render is `false` everywhere
  // (matches the SSR HTML); the post-mount setState repaints with
  // the iOS hint when relevant.
  const [iosHinted, setIosHinted] = useState(false);
  useEffect(() => {
    if (isLikelyIos()) setIosHinted(true);
  }, []);
  // Last-accepted file list — surfaced to assistive tech via aria-live so a
  // screen reader hears "3 files selected: a.png, b.png, c.png" the instant
  // the drop completes.
  const [lastAccepted, setLastAccepted] = useState<string[]>([]);
  // User-visible rejection message when one or more files don't match
  // the accept list. Empty string = no rejection. Per UI-audit
  // CRITICAL #4 — the previous picker silently accepted .txt files
  // and the failure only surfaced on the server's 415, after the
  // user had filled in the entire form.
  const [rejection, setRejection] = useState<string>("");
  const inputRef = useRef<HTMLInputElement>(null);
  // Photos-only input (iOS only). iOS Safari opens the Photos picker
  // — and allows multi-select from Camera Roll — ONLY when the
  // `accept` attribute is restricted to image MIMEs with no
  // application types in the same input. Our default unified picker
  // accepts both images and PDFs/JSONs in one input, which forces
  // iOS into the Files-app picker (single-select only, no Photos
  // multi-select). To work around this without compromising desktop
  // users, iOS users get a SECONDARY "Choose photos" button next to
  // the main one that opens an images-only picker. Desktop / Android
  // users never see this button.
  const photoInputRef = useRef<HTMLInputElement>(null);

  const filterAccepted = useCallback(
    (files: File[]): { kept: File[]; rejected: File[] } => {
      const kept: File[] = [];
      const rejected: File[] = [];
      for (const f of files) {
        // Primary check: browser-reported MIME matches the allow-list.
        if (f.type && accept.includes(f.type)) {
          kept.push(f);
          continue;
        }
        // Fallback: browser reported empty/unknown MIME (Windows
        // Explorer does this for several types). Use the file's
        // extension to look up the canonical MIME and re-check.
        const dot = f.name.lastIndexOf(".");
        if (dot !== -1) {
          const ext = f.name.slice(dot + 1).toLowerCase();
          const guessed = EXT_TO_MIME[ext];
          if (guessed && accept.includes(guessed)) {
            kept.push(f);
            continue;
          }
        }
        rejected.push(f);
      }
      return { kept, rejected };
    },
    [accept],
  );

  const announceRejection = useCallback((rejected: File[]) => {
    if (rejected.length === 0) return;
    const names = rejected.map((f) => f.name).join(", ");
    setRejection(
      `Rejected ${rejected.length} file${rejected.length === 1 ? "" : "s"} ` +
        `with unsupported type: ${names}. Accepted: JPEG, PNG, WebP, HEIC (label images); PDF, JSON, CSV, MD, TXT, DOCX (application files).`,
    );
  }, []);

  const handleDrop = useCallback(
    (e: React.DragEvent<HTMLDivElement>) => {
      e.preventDefault();
      setDragOver(false);
      if (disabled) return;
      const all = Array.from(e.dataTransfer.files);
      const { kept, rejected } = filterAccepted(all);
      announceRejection(rejected);
      if (kept.length) {
        setRejection("");
        setLastAccepted(kept.map((f) => f.name));
        onFiles(kept);
      }
    },
    [announceRejection, disabled, filterAccepted, onFiles],
  );

  const handleSelect = useCallback(
    (e: React.ChangeEvent<HTMLInputElement>) => {
      // The `accept` attribute on the underlying <input> is only a
      // hint to the OS file picker, not enforced — users can switch
      // the picker to "All files" and pick anything. Filter here so a
      // rejected file shows a clear in-page error rather than
      // silently filling the form and 415-ing at Verify time.
      const all = Array.from(e.target.files ?? []);
      const { kept, rejected } = filterAccepted(all);
      announceRejection(rejected);
      if (kept.length) {
        setRejection("");
        setLastAccepted(kept.map((f) => f.name));
        onFiles(kept);
      }
      e.target.value = "";
    },
    [announceRejection, filterAccepted, onFiles],
  );

  const isAppend = mode === "append";
  return (
    <div
      role="region"
      aria-label={isAppend ? "Add more files" : "Label upload area"}
      className="space-y-2"
    >
      <div
        aria-disabled={disabled}
        onDragOver={(e) => {
          e.preventDefault();
          if (!disabled) setDragOver(true);
        }}
        onDragLeave={() => setDragOver(false)}
        onDrop={handleDrop}
        className={`flex flex-col items-center justify-center rounded-xl border-2 border-dashed bg-white text-center transition-colors dark:bg-slate-900 ${
          isAppend
            ? "min-h-[7rem] p-4 sm:min-h-[8rem] sm:p-5"
            : "min-h-[12rem] p-6 sm:min-h-[14rem] sm:p-8"
        } ${
          dragOver
            ? "border-blue-500 dropzone-active dark:border-blue-400"
            : "border-slate-300 hover:border-slate-400 dark:border-slate-600 dark:hover:border-slate-500"
        } ${disabled ? "opacity-60" : ""}`}
      >
        {isAppend ? (
          <>
            <div className="text-base font-medium text-slate-800 dark:text-slate-100">
              Add more files
            </div>
            <div className="mt-0.5 text-xs text-slate-500 dark:text-slate-400">
              Drop or pick more images and application files — they&apos;ll be added to what&apos;s already staged.
            </div>
            {iosHinted ? (
              <div className="mt-1 text-xs text-blue-700 dark:text-blue-300">
                On iPhone or iPad? Use <span className="font-semibold">Choose photos</span> to multi-select from Camera Roll, or tap <span className="font-semibold">Add more files</span> once per app document (PDF, JSON, CSV) — every selection adds to the staged set.
              </div>
            ) : null}
          </>
        ) : (
          <>
            <div className="text-lg font-medium text-slate-800 dark:text-slate-100 sm:text-xl">
              Drop a label image (+ application file, optional)
            </div>
            <div className="mt-1 text-sm text-slate-500 dark:text-slate-400">
              or use the button below · images: JPEG, PNG, WebP, HEIC · applications: PDF, JSON, CSV, MD, TXT, DOCX
            </div>
            <div className="mt-1 text-xs text-slate-400 dark:text-slate-500">
              Drop one image to verify single; image + matching application file to pre-fill the form; or N image/application pairs for batch.
            </div>
            {iosHinted ? (
              <div className="mt-1 text-xs text-blue-700 dark:text-blue-300">
                On iPhone or iPad? Use <span className="font-semibold">Choose photos</span> for the Camera Roll multi-select picker — it lets you pick all your label photos in one tap. Use <span className="font-semibold">Choose files</span> for PDFs or other application documents.
              </div>
            ) : null}
          </>
        )}
        <div
          className={`flex flex-wrap items-center justify-center gap-2 ${
            isAppend ? "mt-3" : "mt-5"
          }`}
        >
          <button
            type="button"
            aria-label={
              isAppend
                ? "Add more files: open picker or drag and drop"
                : "Upload label images: drag and drop, or press Enter to browse"
            }
            className={`min-h-[44px] rounded-md text-sm font-semibold text-white disabled:cursor-not-allowed disabled:opacity-60 ${
              isAppend
                ? "bg-slate-700 px-4 py-2 hover:bg-slate-600 dark:bg-blue-700 dark:hover:bg-blue-600"
                : "bg-slate-900 px-5 py-2.5 hover:bg-slate-700 dark:bg-blue-600 dark:hover:bg-blue-500"
            }`}
            disabled={disabled}
            onClick={() => inputRef.current?.click()}
          >
            {isAppend ? "Add more files" : "Choose files"}
          </button>
          {/* iOS-only secondary button: an images-only picker that
              opens the Photos app's multi-select sheet on iOS 14+.
              Hidden on desktop/Android — those users have the
              main picker which already handles images. */}
          {iosHinted ? (
            <button
              type="button"
              aria-label="Choose photos from Camera Roll (multi-select)"
              className={`min-h-[44px] rounded-md border text-sm font-semibold disabled:cursor-not-allowed disabled:opacity-60 ${
                isAppend
                  ? "border-slate-300 bg-white px-3 py-2 text-slate-700 hover:bg-slate-50 dark:border-slate-600 dark:bg-slate-800 dark:text-slate-100 dark:hover:bg-slate-700"
                  : "border-slate-300 bg-white px-4 py-2.5 text-slate-700 hover:bg-slate-50 dark:border-slate-600 dark:bg-slate-800 dark:text-slate-100 dark:hover:bg-slate-700"
              }`}
              disabled={disabled}
              onClick={() => photoInputRef.current?.click()}
            >
              Choose photos (multi-select)
            </button>
          ) : null}
        </div>
        <input
          ref={inputRef}
          type="file"
          className="hidden"
          accept={accept.join(",")}
          multiple={multiple}
          onChange={handleSelect}
        />
        {/* Images-only input wired to the secondary iOS button. Same
            change-handler — the parent merges the resulting selection
            into its staged set the same way. */}
        <input
          ref={photoInputRef}
          type="file"
          className="hidden"
          accept="image/*"
          multiple={multiple}
          onChange={handleSelect}
        />
      </div>
      {/* Visible rejection notice when a non-allowed file is picked. */}
      {rejection ? (
        <div
          role="alert"
          className="rounded-md border-l-4 border-red-500 bg-red-50 p-3 text-sm text-red-900 dark:border-red-400 dark:bg-red-950/60 dark:text-red-200"
        >
          {rejection}
        </div>
      ) : null}
      {/* Screen-reader announcement of the accepted file set. Visually
          hidden — sighted users see the file preview in the parent. */}
      <div
        className="sr-only"
        role="status"
        aria-live="polite"
        aria-atomic="true"
      >
        {lastAccepted.length > 0
          ? `${lastAccepted.length} file${lastAccepted.length === 1 ? "" : "s"} selected: ${lastAccepted.join(", ")}`
          : ""}
      </div>
    </div>
  );
}
