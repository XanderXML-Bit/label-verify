"use client";

import { useCallback, useRef, useState } from "react";

interface UploadZoneProps {
  readonly onFiles: (files: File[]) => void;
  readonly accept?: string[];
  readonly multiple?: boolean;
  readonly disabled?: boolean;
}

const DEFAULT_ACCEPT = [
  "image/jpeg",
  "image/png",
  "image/webp",
  "application/pdf",
];

export function UploadZone({
  onFiles,
  accept = DEFAULT_ACCEPT,
  multiple = true,
  disabled = false,
}: UploadZoneProps) {
  const [dragOver, setDragOver] = useState(false);
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

  const filterAccepted = useCallback(
    (files: File[]): { kept: File[]; rejected: File[] } => {
      const kept: File[] = [];
      const rejected: File[] = [];
      for (const f of files) {
        if (accept.includes(f.type)) kept.push(f);
        else rejected.push(f);
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
        `with unsupported type: ${names}. Use JPEG, PNG, WebP, or PDF.`,
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

  return (
    <div
      role="region"
      aria-label="Label upload area"
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
        className={`flex min-h-[12rem] flex-col items-center justify-center rounded-xl border-2 border-dashed bg-white p-6 text-center transition-colors dark:bg-slate-900 sm:min-h-[14rem] sm:p-8 ${
          dragOver
            ? "border-blue-500 dropzone-active dark:border-blue-400"
            : "border-slate-300 hover:border-slate-400 dark:border-slate-600 dark:hover:border-slate-500"
        } ${disabled ? "opacity-60" : ""}`}
      >
        <div className="text-lg font-medium text-slate-800 dark:text-slate-100 sm:text-xl">
          Drop label images here
        </div>
        <div className="mt-1 text-sm text-slate-500 dark:text-slate-400">
          or use the button below · JPEG, PNG, WebP, PDF
        </div>
        <div className="mt-1 text-xs text-slate-400 dark:text-slate-500">
          Single image, batch upload, or a folder
        </div>
        <button
          type="button"
          aria-label="Upload label images: drag and drop, or press Enter to browse"
          className="mt-5 min-h-[44px] rounded-md bg-slate-900 px-5 py-2.5 text-sm font-semibold text-white hover:bg-slate-700 disabled:cursor-not-allowed disabled:opacity-60 dark:bg-blue-600 dark:hover:bg-blue-500"
          disabled={disabled}
          onClick={() => inputRef.current?.click()}
        >
          Choose files
        </button>
        <input
          ref={inputRef}
          type="file"
          className="hidden"
          accept={accept.join(",")}
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
