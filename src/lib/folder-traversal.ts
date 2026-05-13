// Recursive folder traversal for the unified drop / pick flow.
//
// When the user drops a folder onto the dropzone, the browser exposes
// each top-level item as a `DataTransferItem`. Calling
// `webkitGetAsEntry()` on each item yields a `FileSystemEntry` that
// either represents a file (read straight away) or a directory (must
// be expanded via `createReader().readEntries()`, which yields
// children in batches of ~100 — the helper has to keep calling
// readEntries until it returns an empty array to signal end-of-
// directory). This module flattens an entry tree into a single
// `File[]` for the rest of the upload pipeline.
//
// The folder-pick path (`<input webkitdirectory>`) does NOT need this
// helper — the browser already flattens the picked folder into a flat
// `FileList` with `webkitRelativePath` populated per entry. This
// helper is exclusively for the drag-and-drop path.
//
// Design choices:
//  - The recursive traversal is bounded by `maxFiles` (default 500) so
//    a user who accidentally drops their home directory doesn't OOM
//    the page. The cap mirrors the per-batch concurrency budget
//    upstream in /api/verify/batch — beyond ~50 images the
//    serverless function timeouts will dominate anyway, so 500
//    leaves headroom for noise (.DS_Store etc.) without becoming a
//    DoS vector.
//  - Errors on subtree reads (permission denied, broken folder) are
//    swallowed so a single bad subtree doesn't poison the whole
//    drop. The unrecoverable kept files are still returned.
//  - The helper does NOT classify the files — that's the caller's
//    job via `partitionFolderResult`, which delegates to whatever
//    `classifyFile` the upload pipeline already uses.

/**
 * Subset of the browser `FileSystemEntry` interface that we actually
 * use. Avoids importing the real lib.dom type so unit tests can
 * synthesise the shape without polyfilling the whole interface (the
 * real interface has filesystem, fullPath, getMetadata, etc., none
 * of which we touch).
 */
export interface FsEntryLike {
  readonly isFile: boolean;
  readonly isDirectory: boolean;
  readonly name: string;
  file?: (
    onSuccess: (file: File) => void,
    onError?: (err: unknown) => void,
  ) => void;
  createReader?: () => FsDirReaderLike;
}

export interface FsDirReaderLike {
  readEntries: (
    onSuccess: (entries: FsEntryLike[]) => void,
    onError?: (err: unknown) => void,
  ) => void;
}

export interface FlattenOptions {
  /** Hard cap on the number of files emitted. Default 500. */
  maxFiles?: number;
  /**
   * Per-directory cap on accumulated child entries before the helper
   * resolves early. Defaults to `maxFiles * 4` — generous enough that
   * a deeply-fanned-out folder (a 50-image batch with associated
   * thumbnails / metadata) reads cleanly, but tight enough that a
   * malicious entry source returning one File per readEntries call
   * doesn't OOM-build the accumulation array before the file-cap
   * cuts in at the outer level. Resolves with whatever was read so
   * far — same "partial-result is fine" stance as subtree errors.
   */
  maxDirChildren?: number;
}

/**
 * Files that should never reach the upload pipeline regardless of
 * extension match. These are OS-generated metadata files that
 * recursive folder scans pick up by accident:
 *  - `.DS_Store` (macOS Finder metadata)
 *  - `Thumbs.db`, `desktop.ini` (Windows Explorer metadata)
 *  - `._*` (macOS resource forks, ALSO surfaces when a HFS+ volume
 *    is read from a non-Apple FS)
 * Plus zero-byte files of any name — those will always 4xx
 * server-side, so the friendlier UX is to skip them client-side
 * with the rest of the "files we recognised but couldn't use" list.
 */
function isSystemNoiseFile(f: File): boolean {
  if (f.size === 0) return true;
  const base = f.name.split(/[\\/]/).pop() ?? f.name;
  if (base === ".DS_Store") return true;
  if (base.toLowerCase() === "thumbs.db") return true;
  if (base.toLowerCase() === "desktop.ini") return true;
  if (base.startsWith("._")) return true;
  return false;
}

/**
 * Walk the given file-system entries depth-first and return every
 * leaf File. Subtree-read errors are silently dropped — the goal is
 * "return what we can read." Caller surfaces a friendly notice if the
 * resulting list is empty.
 *
 * Bounded by `opts.maxFiles` (default 500): once the cap is hit the
 * helper short-circuits and returns the current accumulation. We do
 * NOT throw — partial results are fine for the upload flow, and a
 * user who tries to drop their home directory deserves the limit
 * surfaced via the empty / count UI rather than a crash.
 */
export async function flattenEntries(
  entries: readonly FsEntryLike[],
  opts: FlattenOptions = {},
): Promise<File[]> {
  const maxFiles = opts.maxFiles ?? 500;
  const maxDirChildren = opts.maxDirChildren ?? maxFiles * 4;
  const out: File[] = [];

  async function visit(entry: FsEntryLike): Promise<void> {
    if (out.length >= maxFiles) return;
    if (entry.isFile) {
      const f = await readFileFromEntry(entry).catch(() => null);
      if (f && !isSystemNoiseFile(f)) {
        out.push(f);
      }
      return;
    }
    if (entry.isDirectory) {
      const children = await readAllDirectoryChildren(entry, {
        maxChildren: maxDirChildren,
      }).catch(() => [] as FsEntryLike[]);
      for (const child of children) {
        if (out.length >= maxFiles) return;
        await visit(child);
      }
    }
    // Anything else (symbolic link, exotic) — skip silently.
  }

  for (const e of entries) {
    if (out.length >= maxFiles) break;
    await visit(e);
  }

  return out;
}

/** Promise-wrap the callback-driven `entry.file()` method. */
function readFileFromEntry(entry: FsEntryLike): Promise<File> {
  return new Promise<File>((resolve, reject) => {
    if (!entry.file) {
      reject(new Error("entry has no file() method"));
      return;
    }
    entry.file(resolve, reject);
  });
}

/**
 * Promise-wrap `createReader().readEntries()` and KEEP CALLING until
 * the reader signals end-of-directory with an empty batch. The
 * browser intentionally caps each batch at ~100 entries to keep the
 * UI thread responsive; a single readEntries call against a 250-file
 * folder returns only the first 100 unless you keep asking.
 *
 * `opts.maxChildren` short-circuits the accumulation once the cap is
 * reached and resolves with whatever was read so far. Without this,
 * a malicious / adversarial directory entry that returns 1-element
 * batches forever would build an unbounded array before the outer
 * `flattenEntries` `maxFiles` check ran.
 */
function readAllDirectoryChildren(
  entry: FsEntryLike,
  opts: { maxChildren: number } = { maxChildren: 2_000 },
): Promise<FsEntryLike[]> {
  return new Promise<FsEntryLike[]>((resolve, reject) => {
    if (!entry.createReader) {
      reject(new Error("entry has no createReader() method"));
      return;
    }
    const reader = entry.createReader();
    const accumulated: FsEntryLike[] = [];
    const drain = (): void => {
      reader.readEntries((batch) => {
        if (batch.length === 0) {
          resolve(accumulated);
          return;
        }
        for (const e of batch) {
          accumulated.push(e);
          if (accumulated.length >= opts.maxChildren) {
            // Stop accumulating — we'll let `flattenEntries` enforce
            // the outer `maxFiles` cap on the partial result.
            resolve(accumulated);
            return;
          }
        }
        // Recurse — readEntries' contract is that callers must keep
        // asking until they get an empty batch.
        drain();
      }, reject);
    };
    drain();
  });
}

/**
 * Pull the top-level FileSystemEntry handles out of a DataTransferItemList.
 * Each item that is not a file (e.g. a "string" item with text/plain
 * MIME) is dropped, as are any items whose `webkitGetAsEntry()`
 * returns null (older browsers / non-file drags).
 *
 * Kept as a one-liner-ish wrapper rather than inlined at the call site
 * so the unsafe `as` cast on `webkitGetAsEntry` lives in exactly one
 * place — and so the UI handler can be mocked at the boundary in
 * tests without simulating the entire DataTransfer ceremony.
 */
export function extractEntriesFromDataTransfer(
  items: DataTransferItemList,
): FsEntryLike[] {
  const out: FsEntryLike[] = [];
  for (let i = 0; i < items.length; i++) {
    const item = items[i];
    if (!item) continue;
    if (item.kind !== "file") continue;
    // `webkitGetAsEntry` is defined on the live DataTransferItem in
    // Chrome/Edge/Safari/Firefox 50+; the older `getAsEntry` doesn't
    // exist anywhere modern. Cast through `unknown` to avoid lib.dom
    // strictness mismatches between Node test-runs and browser builds.
    type WithEntry = DataTransferItem & {
      webkitGetAsEntry?: () => FsEntryLike | null;
    };
    const entry = (item as WithEntry).webkitGetAsEntry?.();
    if (entry) out.push(entry);
  }
  return out;
}

/**
 * Three-way split of the flattened files by content kind. The
 * `classify` callback is injected so the helper stays decoupled
 * from the project's MIME / extension policy — the caller passes
 * its existing `classifyFile` from `batch-pairing.ts`. The
 * `unknown` bucket name in the callback signature is intentionally
 * agnostic so callers can also pass test stubs; the project's
 * `FileKind` uses `"other"` for its unknown bucket — both map to
 * `ignored`. Any returned string that isn't `"image"` or
 * `"application"` is treated as ignored.
 */
export function partitionFolderResult(
  files: readonly File[],
  classify: (f: File) => string,
): { images: File[]; apps: File[]; ignored: File[] } {
  const images: File[] = [];
  const apps: File[] = [];
  const ignored: File[] = [];
  for (const f of files) {
    const k = classify(f);
    if (k === "image") images.push(f);
    else if (k === "application") apps.push(f);
    else ignored.push(f);
  }
  return { images, apps, ignored };
}
