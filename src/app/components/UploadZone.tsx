"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { isLikelyIos, supportsFolderUpload } from "@/lib/upload-merge";
import {
  extractEntriesFromDataTransfer,
  flattenEntries,
} from "@/lib/folder-traversal";

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
  // Whether to show the "Choose folder" affordance. Feature-detected
  // post-mount rather than UA-sniffed because folder support is now
  // available on Chromium-on-iPadOS 16.4+, Chrome / Edge / Firefox
  // 50+ / Safari 11.1+ — every major non-iOS-Safari browser, and
  // even some iOS variants. The probe is cheaper to maintain than a
  // per-OS-version compatibility table.
  const [folderSupported, setFolderSupported] = useState(false);
  useEffect(() => {
    if (isLikelyIos()) setIosHinted(true);
    if (supportsFolderUpload()) setFolderSupported(true);
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
  // Hidden input wired to the "Choose folder" button. The
  // `webkitdirectory` attribute (and TypeScript-friendly cast applied
  // at render time) tells the browser to expose its directory picker.
  // The resulting FileList is already flattened by the browser, so
  // the change handler can reuse `handleSelect` verbatim.
  const folderInputRef = useRef<HTMLInputElement>(null);
  // (Previously tracked whether the most-recent action was a folder
  // vs. a file pick to switch notice copy. After the wave-12 review
  // pass split the empty-folder notice into "truly empty" vs.
  // "all rejected" via `emptyFolderHadFiles`, the source-was-folder
  // flag became redundant — the presence of `emptyFolderName`
  // alone implies a folder source. Field removed; kept this comment
  // so future contributors don't reintroduce it.)
  // Notice when a folder drop / pick yielded zero valid files. Shown
  // in addition to (or instead of) the per-file rejection notice so
  // the user understands their action didn't silently no-op.
  const [emptyFolderName, setEmptyFolderName] = useState<string>("");
  // Whether the empty folder also contained NO files at all (truly
  // empty) vs. files-but-all-rejected. Used to switch the notice
  // copy ("the folder was empty" vs. "we found files but none
  // matched the accepted types"). The per-file rejection notice
  // surfaces the rejected names separately when applicable.
  const [emptyFolderHadFiles, setEmptyFolderHadFiles] = useState(false);

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
    if (rejected.length === 0) {
      // Clear any stale rejection notice from a previous attempt.
      // We make this the single source of truth for the rejection
      // state so the kept-branch in handleDrop/handleSelect doesn't
      // need to call `setRejection("")` separately — and so the
      // common case of "1 valid + 1 invalid in the same drop"
      // surfaces the invalid-file notice instead of being clobbered.
      setRejection("");
      return;
    }
    const names = rejected.map((f) => f.name).join(", ");
    setRejection(
      `Rejected ${rejected.length} file${rejected.length === 1 ? "" : "s"} ` +
        `with unsupported type: ${names}. Accepted: JPEG, PNG, WebP, HEIC (label images); PDF, JSON, CSV, MD, TXT, DOCX (application files).`,
    );
  }, []);

  const handleDrop = useCallback(
    async (e: React.DragEvent<HTMLDivElement>) => {
      e.preventDefault();
      setDragOver(false);
      if (disabled) return;
      // CRITICAL: capture every piece of state we need from the event
      // object SYNCHRONOUSLY, before any `await`. The handler became
      // async to support folder traversal, but `e.dataTransfer.items`
      // and `e.dataTransfer.files` are live browser objects that some
      // browsers clear once the drop event returns to the event loop.
      // After `await flattenEntries(...)`, attempting to read
      // `e.dataTransfer.files` may yield an empty list. Snapshot here.
      const items = e.dataTransfer.items;
      const droppedFilesSnapshot = Array.from(e.dataTransfer.files);
      const entries =
        typeof DataTransferItem !== "undefined" && items
          ? extractEntriesFromDataTransfer(items)
          : [];
      const hasDirectory = entries.some((entry) => entry.isDirectory);
      let all: File[];
      let folderName = "";
      let sourceWasFolder = false;
      if (hasDirectory) {
        sourceWasFolder = true;
        // Pick the FIRST directory's name as the displayed folder
        // (multi-folder drops are unusual; using "multiple folders"
        // copy when the user dropped two folders is acceptable).
        const firstDir = entries.find((entry) => entry.isDirectory);
        // `firstDir?.name` can be the empty string on some exotic
        // file systems (encrypted volume mount points). Fall back to
        // a generic label so the notice doesn't render as "in ''".
        folderName = firstDir?.name?.trim() || "folder";
        try {
          all = await flattenEntries(entries);
        } catch {
          // Defensive — flattenEntries already swallows subtree errors;
          // a top-level throw should never happen, but if it does we
          // fall back to the pre-await files snapshot.
          all = droppedFilesSnapshot;
        }
      } else {
        all = droppedFilesSnapshot;
      }
      const { kept, rejected } = filterAccepted(all);
      announceRejection(rejected);
      // Always reset the source / folder-name state on every entry so
      // a stale amber notice from a previous folder action doesn't
      // linger after a subsequent non-folder pick.
      setEmptyFolderName("");
      setEmptyFolderHadFiles(false);
      if (kept.length) {
        setLastAccepted(kept.map((f) => f.name));
        onFiles(kept);
      } else if (sourceWasFolder) {
        // Folder drop with zero kept files — surface a focused notice
        // so the user knows the action happened. We deliberately do
        // NOT call onFiles so the parent stage doesn't churn. The
        // `hadFiles` flag drives the notice copy: an empty folder
        // vs. a folder of unsupported files reads differently.
        setEmptyFolderName(folderName);
        setEmptyFolderHadFiles(all.length > 0);
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
      // Folder picks come through `<input webkitdirectory>` already
      // flattened by the browser; each File has a `webkitRelativePath`
      // like "myfolder/sub/a.png". Detect this and switch the
      // empty-result notice copy accordingly. We can't rely on
      // `e.target` having a webkitdirectory attribute because the
      // photo-picker input might share the handler in future
      // refactors — the per-File `webkitRelativePath` is the
      // canonical signal.
      type FileWithRel = File & { webkitRelativePath?: string };
      const firstWithRel = all.find(
        (f) => !!(f as FileWithRel).webkitRelativePath,
      ) as FileWithRel | undefined;
      const isFolderPick = !!firstWithRel;
      let folderName = "";
      if (isFolderPick) {
        const seg = (firstWithRel.webkitRelativePath ?? "").split("/")[0];
        // `seg` may be `""` when the browser populated an empty
        // `webkitRelativePath` (rare, but observed on some Chromium
        // forks). `String.split` always returns ≥ 1 element so the
        // `?? "folder"` chain that lived here previously was dead
        // code — fall back via `||` instead.
        folderName = (seg ?? "").trim() || "folder";
      }
      const { kept, rejected } = filterAccepted(all);
      announceRejection(rejected);
      // Always reset on every entry so a stale folder-pick notice
      // doesn't linger after a subsequent single-file pick.
      setEmptyFolderName("");
      setEmptyFolderHadFiles(false);
      if (kept.length) {
        setLastAccepted(kept.map((f) => f.name));
        onFiles(kept);
      } else if (isFolderPick) {
        setEmptyFolderName(folderName);
        setEmptyFolderHadFiles(all.length > 0);
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
              Drop or pick more images, application files, or a whole folder — every selection is added to what&apos;s already staged.
            </div>
            {iosHinted ? (
              <div className="mt-1 text-xs text-blue-700 dark:text-blue-300">
                On iPhone or iPad: tap <span className="font-semibold">Add photos</span> to multi-select label photos from Camera Roll. Use <span className="font-semibold">Add document</span> once per PDF / JSON / CSV.
              </div>
            ) : null}
          </>
        ) : (
          <>
            <div className="text-lg font-medium text-slate-800 dark:text-slate-100 sm:text-xl">
              Drop a label image, folder, or application file
            </div>
            <div className="mt-1 text-sm text-slate-500 dark:text-slate-400">
              or use the buttons below · images: JPEG, PNG, WebP, HEIC · applications: PDF, JSON, CSV, MD, TXT, DOCX · folders are scanned recursively
            </div>
            <div className="mt-1 text-xs text-slate-400 dark:text-slate-500">
              Drop one image to verify single; image + matching application file to pre-fill the form; or N image/application pairs (or a folder of them) for batch. Files we don&apos;t recognise are ignored with a list.
            </div>
            {iosHinted ? (
              <div className="mt-1 text-xs text-blue-700 dark:text-blue-300">
                On iPhone or iPad: <span className="font-semibold">Choose photos</span> is the multi-select Camera Roll picker — use it for label photos. <span className="font-semibold">Choose document</span> handles PDFs / JSONs / CSVs one at a time.
              </div>
            ) : null}
          </>
        )}
        <div
          className={`flex flex-wrap items-center justify-center gap-2 ${
            isAppend ? "mt-3" : "mt-5"
          }`}
        >
          {/* iOS-PRIMARY PHOTOS BUTTON (wave-34).
              Production bug reported 2026-05-17: an iPhone user dropped
              5 label photos and only 1 came through. Root cause: the
              UNIFIED primary input has `accept` listing both image and
              application MIMEs (PDF, JSON, CSV, DOCX). iOS Safari sees
              the mixed types and opens the Files-app picker, which is
              SINGLE-SELECT only — the Photos-app multi-select picker
              is only reachable from an image-only `accept`. The user
              tapped the prominent "Choose files" CTA, got Files
              picker, picked 1 photo, and got dropped into single-pending
              (not batch). The "Choose photos (multi-select)" secondary
              button existed but was visually deprioritised — the user
              never saw it.
              Fix: on iOS, swap the order. Photos picker is the
              PRIMARY CTA (matches the 95% case on phones — pick a
              label photo). Documents picker becomes the secondary.
              Desktop / Android behaviour unchanged (unified picker
              there handles multi-select natively, so it stays
              primary). */}
          {iosHinted ? (
            <button
              type="button"
              aria-label={
                isAppend
                  ? "Add photos from Camera Roll (multi-select)"
                  : "Choose photos from Camera Roll: multi-select supported"
              }
              className={`min-h-[44px] rounded-md text-sm font-semibold text-white disabled:cursor-not-allowed disabled:opacity-60 ${
                isAppend
                  ? "bg-slate-700 px-4 py-2 hover:bg-slate-600 dark:bg-blue-700 dark:hover:bg-blue-600"
                  : "bg-slate-900 px-5 py-2.5 hover:bg-slate-700 dark:bg-blue-600 dark:hover:bg-blue-500"
              }`}
              disabled={disabled}
              onClick={() => photoInputRef.current?.click()}
            >
              {isAppend ? "Add photos" : "Choose photos"}
            </button>
          ) : null}
          <button
            type="button"
            aria-label={
              iosHinted
                ? isAppend
                  ? "Add a PDF or other application document"
                  : "Choose a PDF or other application document (single file)"
                : isAppend
                  ? "Add more files: open picker or drag and drop"
                  : "Upload label images: drag and drop, or press Enter to browse"
            }
            className={`min-h-[44px] rounded-md text-sm font-semibold disabled:cursor-not-allowed disabled:opacity-60 ${
              iosHinted
                ? // On iOS the unified button is the SECONDARY action
                  // (white/border styling) because Photos picker took
                  // the primary slot. The button still opens the
                  // unified input so the user can hand-pick a PDF /
                  // JSON / CSV from Files-app.
                  isAppend
                    ? "border border-slate-300 bg-white px-3 py-2 text-slate-700 hover:bg-slate-50 dark:border-slate-600 dark:bg-slate-800 dark:text-slate-100 dark:hover:bg-slate-700"
                    : "border border-slate-300 bg-white px-4 py-2.5 text-slate-700 hover:bg-slate-50 dark:border-slate-600 dark:bg-slate-800 dark:text-slate-100 dark:hover:bg-slate-700"
                : // Desktop / Android: unified picker IS the primary.
                  isAppend
                  ? "bg-slate-700 px-4 py-2 text-white hover:bg-slate-600 dark:bg-blue-700 dark:hover:bg-blue-600"
                  : "bg-slate-900 px-5 py-2.5 text-white hover:bg-slate-700 dark:bg-blue-600 dark:hover:bg-blue-500"
            }`}
            disabled={disabled}
            onClick={() => inputRef.current?.click()}
          >
            {iosHinted
              ? isAppend
                ? "Add document"
                : "Choose document"
              : isAppend
                ? "Add more files"
                : "Choose files"}
          </button>
          {/* Tertiary button: folder picker. The browser flattens the
              selected folder into a FileList for us (each entry gets a
              `webkitRelativePath`), so the same handleSelect handles
              the result — no separate dispatch. Feature-detected
              (post-mount) rather than UA-sniffed so capable browsers
              get the affordance even on iPadOS 16.4+; incapable
              browsers (older iOS Safari) silently lose the button. */}
          {folderSupported ? (
            <button
              type="button"
              aria-label="Choose a folder of label images and application files"
              className={`min-h-[44px] rounded-md border text-sm font-semibold disabled:cursor-not-allowed disabled:opacity-60 ${
                isAppend
                  ? "border-slate-300 bg-white px-3 py-2 text-slate-700 hover:bg-slate-50 dark:border-slate-600 dark:bg-slate-800 dark:text-slate-100 dark:hover:bg-slate-700"
                  : "border-slate-300 bg-white px-4 py-2.5 text-slate-700 hover:bg-slate-50 dark:border-slate-600 dark:bg-slate-800 dark:text-slate-100 dark:hover:bg-slate-700"
              }`}
              disabled={disabled}
              onClick={() => folderInputRef.current?.click()}
            >
              Choose folder
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
        {/* Folder picker input. `webkitdirectory` / `directory` are not
            in lib.dom.d.ts on every TS version, so we cast through a
            spread of any-typed attributes. The browser populates each
            File's `webkitRelativePath`, which `handleSelect` uses to
            detect that the source was a folder and switch copy on
            the empty-result notice. */}
        <input
          ref={folderInputRef}
          type="file"
          className="hidden"
          // eslint-disable-next-line @typescript-eslint/no-explicit-any -- webkitdirectory not in lib.dom yet
          {...({ webkitdirectory: "", directory: "" } as any)}
          multiple
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
      {/* Folder-scan-found-nothing notice. Shown in addition to (or
          instead of) the rejection notice so the user understands
          their drop/pick happened but contained no valid label or
          application files. Copy switches based on whether the
          folder was truly empty vs. contained files but none of
          the right type — the latter case is paired with the
          red per-file rejection notice that lists the file names. */}
      {emptyFolderName ? (
        <div
          role="alert"
          aria-live="polite"
          className="rounded-md border-l-4 border-amber-500 bg-amber-50 p-3 text-sm text-amber-900 dark:border-amber-400 dark:bg-amber-950/60 dark:text-amber-200"
        >
          {emptyFolderHadFiles ? (
            <>
              <p className="font-semibold">
                No valid label images or application files in &quot;
                <span className="font-mono">{emptyFolderName}</span>&quot;
              </p>
              <p className="mt-0.5">
                We scanned the folder and found files, but none matched the accepted types — see the red list above for what was rejected. Drop a folder that contains at least one JPEG / PNG / WebP / HEIC label image, or use <span className="font-semibold">Choose files</span> to pick one directly.
              </p>
            </>
          ) : (
            <>
              <p className="font-semibold">
                &quot;<span className="font-mono">{emptyFolderName}</span>&quot; looks empty
              </p>
              <p className="mt-0.5">
                We scanned the folder but didn&apos;t find any files at all. Drop a folder that contains at least one label image (JPEG / PNG / WebP / HEIC) — and optionally an application file (PDF / JSON / CSV / MD / TXT / DOCX) per image — or use <span className="font-semibold">Choose files</span> to pick them individually.
              </p>
            </>
          )}
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
