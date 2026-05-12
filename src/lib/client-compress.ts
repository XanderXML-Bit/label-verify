// ─── client-compress ───────────────────────────────────────────────────────
//
// Browser-side image compression. Phone photos from a typical reviewer's
// camera roll are 3–8 MB at 4032 × 3024 — far larger than the verifier
// needs (vision API downsamples internally anyway, and OCR works on a
// 1600 px long edge). Shrinking client-side directly attacks the upload
// latency budget, especially on cellular / hotel Wi-Fi.
//
// We deliberately use only the Canvas 2D API (no `OffscreenCanvas`, no new
// deps) so the helper works in every evergreen browser. HEIC / unusual
// formats that the browser can't decode in <img> fall through to the
// original file unchanged.

export interface CompressOptions {
  /** Long-edge cap in CSS pixels. Default 1600. Images smaller than this
   *  are still re-encoded so we always emit predictable JPEG bytes. */
  readonly maxEdge?: number;
  /** JPEG quality (0–1). Default 0.82 — visually indistinguishable from
   *  the source for label photography. */
  readonly quality?: number;
}

const DEFAULT_MAX_EDGE = 1600;
const DEFAULT_QUALITY = 0.82;

/**
 * Resize and re-encode an image File in the browser before upload.
 *
 * Returns the original `file` unchanged if:
 *   - we're running outside a browser (e.g. jsdom without canvas, SSR)
 *   - the file is not an image MIME type
 *   - the browser fails to decode it (HEIC, corrupted JPEG, etc.)
 *   - the produced JPEG would be larger than the original (e.g. already
 *     a tightly-compressed thumbnail) — in that case the original wins
 *
 * The output filename preserves the original stem and is appended with
 * `.jpg` so the server still has a recognizable name to log.
 */
export async function compressImageInBrowser(
  file: File,
  opts: CompressOptions = {},
): Promise<File> {
  const maxEdge = opts.maxEdge ?? DEFAULT_MAX_EDGE;
  const quality = opts.quality ?? DEFAULT_QUALITY;

  // SSR / non-DOM environments. Tests in jsdom land here when canvas
  // support is missing (which is the jsdom default).
  if (
    typeof window === "undefined" ||
    typeof document === "undefined" ||
    typeof URL === "undefined"
  ) {
    return file;
  }
  if (!file.type.startsWith("image/")) {
    return file;
  }

  let objectUrl: string | null = null;
  try {
    objectUrl = URL.createObjectURL(file);
    const img = await loadImage(objectUrl);
    const { width, height } = scaleToFit(img.naturalWidth, img.naturalHeight, maxEdge);

    const canvas = document.createElement("canvas");
    canvas.width = width;
    canvas.height = height;
    const ctx = canvas.getContext("2d");
    if (!ctx) return file;
    ctx.drawImage(img, 0, 0, width, height);

    const blob = await canvasToBlob(canvas, "image/jpeg", quality);
    if (!blob) return file;
    // If compression made it bigger (rare, but happens on already-tiny
    // images), fall back to the original.
    if (blob.size >= file.size) return file;

    const renamed = renameToJpg(file.name);
    return new File([blob], renamed, {
      type: "image/jpeg",
      lastModified: file.lastModified,
    });
  } catch {
    // HEIC and other formats the browser can't decode throw on <img>.load.
    return file;
  } finally {
    if (objectUrl) URL.revokeObjectURL(objectUrl);
  }
}

function loadImage(src: string): Promise<HTMLImageElement> {
  return new Promise((resolve, reject) => {
    const img = new Image();
    img.onload = () => resolve(img);
    img.onerror = () => reject(new Error("image decode failed"));
    img.src = src;
  });
}

function canvasToBlob(
  canvas: HTMLCanvasElement,
  type: string,
  quality: number,
): Promise<Blob | null> {
  return new Promise((resolve) => {
    // toBlob is the modern API but jsdom (and ancient browsers) may not
    // implement it; fall back to toDataURL → fetch in those cases.
    if (typeof canvas.toBlob === "function") {
      canvas.toBlob((b) => resolve(b), type, quality);
      return;
    }
    try {
      const url = canvas.toDataURL(type, quality);
      fetch(url)
        .then((r) => r.blob())
        .then(resolve)
        .catch(() => resolve(null));
    } catch {
      resolve(null);
    }
  });
}

export function scaleToFit(
  srcWidth: number,
  srcHeight: number,
  maxEdge: number,
): { width: number; height: number } {
  const longest = Math.max(srcWidth, srcHeight);
  if (longest <= maxEdge) {
    return { width: srcWidth, height: srcHeight };
  }
  const scale = maxEdge / longest;
  return {
    width: Math.max(1, Math.round(srcWidth * scale)),
    height: Math.max(1, Math.round(srcHeight * scale)),
  };
}

function renameToJpg(name: string): string {
  const dot = name.lastIndexOf(".");
  const stem = dot > 0 ? name.slice(0, dot) : name;
  return `${stem}.jpg`;
}
