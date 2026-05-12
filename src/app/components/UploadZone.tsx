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
  const inputRef = useRef<HTMLInputElement>(null);

  const handleDrop = useCallback(
    (e: React.DragEvent<HTMLDivElement>) => {
      e.preventDefault();
      setDragOver(false);
      if (disabled) return;
      const files = Array.from(e.dataTransfer.files).filter((f) =>
        accept.includes(f.type),
      );
      if (files.length) {
        setLastAccepted(files.map((f) => f.name));
        onFiles(files);
      }
    },
    [accept, disabled, onFiles],
  );

  const handleSelect = useCallback(
    (e: React.ChangeEvent<HTMLInputElement>) => {
      const files = Array.from(e.target.files ?? []);
      if (files.length) {
        setLastAccepted(files.map((f) => f.name));
        onFiles(files);
      }
      e.target.value = "";
    },
    [onFiles],
  );

  return (
    <div
      role="region"
      aria-label="Label upload area"
      className="space-y-2"
    >
      <div
        role="button"
        tabIndex={0}
        aria-disabled={disabled}
        aria-label="Upload label images: drag and drop, or press Enter to browse"
        onClick={() => inputRef.current?.click()}
        onKeyDown={(e) => {
          if (e.key === "Enter" || e.key === " ") {
            e.preventDefault();
            inputRef.current?.click();
          }
        }}
        onDragOver={(e) => {
          e.preventDefault();
          if (!disabled) setDragOver(true);
        }}
        onDragLeave={() => setDragOver(false)}
        onDrop={handleDrop}
        className={`flex min-h-[12rem] flex-col items-center justify-center rounded-xl border-2 border-dashed bg-white p-6 text-center transition-colors sm:min-h-[14rem] sm:p-8 ${
          dragOver
            ? "border-blue-500 dropzone-active"
            : "border-slate-300 hover:border-slate-400"
        } ${disabled ? "opacity-60" : "cursor-pointer"}`}
      >
        <div className="text-lg font-medium text-slate-800 sm:text-xl">
          Drop label images here
        </div>
        <div className="mt-1 text-sm text-slate-500">
          or click to browse · JPEG, PNG, WebP, PDF
        </div>
        <div className="mt-1 text-xs text-slate-400">
          Single image, batch upload, or a folder
        </div>
        <button
          type="button"
          className="mt-5 min-h-[44px] rounded-md bg-slate-900 px-5 py-2.5 text-sm font-semibold text-white hover:bg-slate-700 disabled:cursor-not-allowed disabled:opacity-60"
          disabled={disabled}
          onClick={(e) => {
            e.stopPropagation();
            inputRef.current?.click();
          }}
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
