import sharp from "sharp";

export interface PreprocessOptions {
  /** Longest edge after resize. Default 1600px keeps detail without bloat. */
  maxEdge?: number;
  /** Apply auto-contrast (`sharp.normalize()`) if the histogram is dim. */
  autoContrast?: boolean;
}

export interface PreprocessedImage {
  /** JPEG buffer ready for the vision API and OCR. */
  buffer: Buffer;
  width: number;
  height: number;
  /**
   * Bytes saved compared to the input — purely informational, surfaced in
   * the debug trace.
   */
  bytesIn: number;
  bytesOut: number;
}

/**
 * Server-side preprocessing per ARCHITECTURE.md §3 step 2:
 *  - EXIF orient (rotate to upright)
 *  - resize so the longest edge is <= maxEdge (default 1600)
 *  - auto-contrast on low-light histograms
 *  - re-encode JPEG quality 82 (good balance of size vs detail for OCR)
 *
 * The 5s latency budget assumes a hot worker; first invocation eats sharp's
 * native-module load time, which is why `/api/warmup` is hit on page load
 * (DEPLOYMENT.md §6).
 */
export async function preprocessImage(
  input: Buffer,
  opts: PreprocessOptions = {},
): Promise<PreprocessedImage> {
  const maxEdge = opts.maxEdge ?? 1600;
  const autoContrast = opts.autoContrast ?? true;

  const bytesIn = input.byteLength;

  let pipeline = sharp(input, { failOn: "none" }).rotate(); // EXIF auto-orient

  // Resize only if the longest edge exceeds the target.
  const meta = await sharp(input).metadata();
  const w = meta.width ?? 0;
  const h = meta.height ?? 0;
  if (Math.max(w, h) > maxEdge) {
    pipeline = pipeline.resize({
      width: w >= h ? maxEdge : undefined,
      height: h > w ? maxEdge : undefined,
      withoutEnlargement: true,
    });
  }

  if (autoContrast) {
    pipeline = pipeline.normalize();
  }

  const { data, info } = await pipeline
    .jpeg({ quality: 82, mozjpeg: true })
    .toBuffer({ resolveWithObject: true });

  return {
    buffer: data,
    width: info.width,
    height: info.height,
    bytesIn,
    bytesOut: data.byteLength,
  };
}
