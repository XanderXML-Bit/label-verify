// Helpers for incremental, additive file staging in the upload flow.
//
// Why this module exists: the iOS Safari file picker often returns only
// the single Photo the user just tapped, even when the underlying
// `<input multiple>` is set. Replacing the staged file set on every
// picker callback drops the user's previously-selected photos and
// leaves them with only the last one. To support iOS users who must
// pick photos one-at-a-time without compromising the desktop
// drag-and-drop-five-files-at-once experience, the page accepts an
// "Add more files" affordance whose handler merges the new selection
// with the existing stage via `mergeFilesForRestage`.
//
// Pure helpers — no DOM / React dependencies, so they're trivially
// unit-testable.

/**
 * Identity key for a browser File. Two File objects represent the same
 * physical file if their (path, name, size, lastModified) tuple
 * matches — the browser doesn't surface a content hash, but in
 * practice this tuple is unique enough for our purposes (we just
 * want to dedupe when the user accidentally re-picks the same
 * photo).
 *
 * Notes:
 *  - We include `webkitRelativePath` so two photos at
 *    `batch1/photo.jpg` and `batch2/photo.jpg` (folder-pick flow)
 *    are kept as distinct files even when their name/size/mtime
 *    happen to match. Wave-12 hypercritical review flagged that
 *    camera burst photos with rounded-to-second timestamps could
 *    legitimately collide on (name, size, lastModified) alone if a
 *    user organised the same camera roll into two folders.
 *  - We do NOT include `type` because Windows Explorer sometimes
 *    reports a different MIME for the same file on a second pick
 *    (especially for HEIC / DOCX); using `type` as part of the key
 *    would cause false-misses on the dedupe.
 */
export function fileIdentityKey(f: File): string {
  type FileWithRel = File & { webkitRelativePath?: string };
  const rel = (f as FileWithRel).webkitRelativePath ?? "";
  return `${rel}::${f.name}::${f.size}::${f.lastModified}`;
}

/**
 * Combine an already-staged file list with a freshly-picked list and
 * return the merged set, preserving order (current first, then new),
 * with duplicates removed. Used by the "Add more files" affordance in
 * single-pending and batch-pending(autoPair) stages.
 *
 * Order-preserving so the user's mental model of the staging tray
 * stays stable: "the photos I added first stay at the top." Dedup
 * happens silently — re-picking the same file is a common iOS
 * mistake when the picker doesn't visually mark previously-selected
 * items.
 */
export function mergeFilesForRestage(
  current: readonly File[],
  additional: readonly File[],
): File[] {
  const seen = new Set<string>();
  const out: File[] = [];
  for (const f of current) {
    const key = fileIdentityKey(f);
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(f);
  }
  for (const f of additional) {
    const key = fileIdentityKey(f);
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(f);
  }
  return out;
}

/**
 * Heuristic to detect iOS Safari / WebKit (incl. iPad on iPadOS 13+
 * which masquerades as macOS Safari but exposes touch input). Used
 * to surface a one-line copy hint above the "Add more files" button
 * so a reviewer on iPhone understands that they may need to tap the
 * picker several times to assemble a 5-photo batch.
 *
 * Returns `false` server-side / in non-browser environments. The
 * check is purposefully ducktyped — UA-sniffing iPadOS reliably is
 * hard, but the cost of a false-positive is one extra line of
 * informational copy, which is harmless on desktop.
 */
export function isLikelyIos(): boolean {
  if (typeof navigator === "undefined") return false;
  const ua = navigator.userAgent || "";
  if (/iPad|iPhone|iPod/.test(ua)) return true;
  // iPadOS 13+: UA reports "Macintosh" but the device exposes a
  // multi-touch interface that Macs never do.
  type NavWithMaxTouch = Navigator & { maxTouchPoints?: number };
  if (
    /Macintosh/.test(ua) &&
    typeof (navigator as NavWithMaxTouch).maxTouchPoints === "number" &&
    ((navigator as NavWithMaxTouch).maxTouchPoints as number) > 1
  ) {
    return true;
  }
  return false;
}

/**
 * Feature-detect whether the current browser supports `<input
 * type="file" webkitdirectory>` and the `DataTransferItem.
 * webkitGetAsEntry()` recursion path. We probe both because a
 * browser may support one without the other (older iPadOS Safari
 * shipped getAsEntry first; webkitdirectory landed later). Used to
 * gate the "Choose folder" button so users on Chromium-on-iPadOS
 * 16.4+ — which DOES support folder picks — get the affordance
 * even though `isLikelyIos()` flags the device. Cheaper / more
 * durable than maintaining a per-OS-version compatibility table.
 *
 * Server-side: returns `false` (the button is hidden in the SSR
 * HTML and `useEffect` re-evaluates after mount). This means the
 * initial paint matches across all clients and only the
 * post-hydration repaint shows the folder button — a one-frame
 * shift on capable browsers, which is acceptable for a discoverability
 * affordance.
 */
export function supportsFolderUpload(): boolean {
  if (typeof window === "undefined") return false;
  // Probe `webkitdirectory` on a transient input element.
  try {
    const probe = document.createElement("input");
    probe.type = "file";
    if (!("webkitdirectory" in probe)) return false;
  } catch {
    return false;
  }
  // Probe `webkitGetAsEntry` on DataTransferItem prototype. The
  // protoype-level check is cheaper than instantiating a synthetic
  // DataTransfer (which Firefox forbids).
  if (typeof DataTransferItem === "undefined") return false;
  if (!("webkitGetAsEntry" in DataTransferItem.prototype)) return false;
  return true;
}
