import sharp from "sharp";

export interface PreprocessOptions {
  /**
   * Longest edge after resize. Default 2000 (wave-31j); legacy callers
   * may pass 1600 to opt back into the wave-28b behaviour.
   */
  maxEdge?: number;
  /** Apply auto-contrast (`sharp.normalize()`) if the histogram is dim. */
  autoContrast?: boolean;
  /**
   * Wave-31j: when true (default), Lanczos-upscale images whose long
   * edge is below `maxEdge`. Set to false to keep small images at their
   * native size (the pre-wave-31j behaviour). Env override:
   * `LV_ENLARGE=0` disables; otherwise defaults to true.
   */
  enlarge?: boolean;
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
 *  - Lanczos-3 resize so the longest edge == maxEdge (wave-31j default 2000;
 *    sub-target images are UPSCALED unless `enlarge:false` or `LV_ENLARGE=0`)
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
  // Wave-31j defaults: long-edge 2000 + Lanczos enlargement.
  //
  // The AI-generated corpus is 1024×1536 (long-edge 1536, below the
  // previous 1600 target). Production used `withoutEnlargement: true`,
  // which kept these images at native size — and the wave-31 stratified
  // bench showed that giving the VLM more pixels at the prefix region
  // catches 4 of 6 synthetic-adversarial false-passes the lower-res
  // image silently waves through. `adversarial.fp-on-correct` drops
  // 6 → 2 and `compliant.false-fail` drops 1 → 0. Latency is faster
  // too (Tesseract finds the prefix more often, doesn't trip the 8 s
  // OCR race timeout). Trade: 4 compliant labels move PASS → REVIEW
  // (~4% additional human-review burden per batch).
  //
  // Aspect ratio is preserved by sharp's `fit: "inside"` semantics
  // (1024×1536 → 1333×2000, aspect 0.6667 → 0.6665, delta < 0.001).
  // Lanczos-3 kernel preserves edge sharpness on the upsampled image.
  //
  // The env-var escape hatches (`LV_MAX_EDGE`, `LV_ENLARGE`) survive
  // for future research benches.
  const envMax = Number(process.env.LV_MAX_EDGE ?? "");
  const envEnlarge = process.env.LV_ENLARGE;
  const maxEdge =
    opts.maxEdge ?? (Number.isFinite(envMax) && envMax > 0 ? envMax : 2000);
  // Default ON; set LV_ENLARGE=0 (env) or opts.enlarge=false to disable.
  const enlarge =
    opts.enlarge ?? (envEnlarge === "0" ? false : true);
  const autoContrast = opts.autoContrast ?? true;

  const bytesIn = input.byteLength;

  // Single sharp pipeline (no separate `.metadata()` pre-pass — the
  // earlier double-pass cost ~20–50 ms per call for no extra signal).
  // The final `info.width` / `info.height` is read off the
  // `toBuffer({ resolveWithObject: true })` result — sharp emits it
  // post-resize without an extra decode.
  let pipeline = sharp(input, { failOn: "none" }).rotate(); // EXIF auto-orient
  pipeline = pipeline.resize({
    width: maxEdge,
    height: maxEdge,
    fit: "inside",
    withoutEnlargement: !enlarge,
    kernel: "lanczos3",
  });
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
