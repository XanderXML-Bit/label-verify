import { preprocessImage } from "./preprocess";
import { GeminiFlashExtractor } from "./vision/gemini";
import { tesseractEngine } from "./ocr/tesseract";
import {
  compareBrand,
  compareAbv,
  compareNetContents,
  compareProducer,
  compareCountry,
  compareClass,
} from "./matching";
import { validateGovernmentWarning } from "./validation/government-warning-validator";
import type {
  DeclaredFields,
  ImageQuality,
  Verdict,
  VerifyResponse,
} from "./types";
import type {
  Extractor,
  ExtractorContext,
  ExtractorResult,
  OcrWord,
} from "./vision/types";
import type { OcrResult } from "./ocr";

interface VerifyOptions {
  extractor?: Extractor;
  /** Hard wall-clock budget for the vision call in ms. */
  visionTimeoutMs?: number;
}

const DEFAULT_VISION_TIMEOUT_MS = 4500;

/**
 * Top-level verify orchestrator. Per ARCHITECTURE.md §3:
 *   1. preprocess
 *   2. OCR + vision in parallel (OCR is conditionally off-path —
 *      we feed it to the vision prompt only if it returns in time)
 *   3. match per-field
 *   4. validate the Government Warning
 *   5. aggregate verdict + image-quality
 */
export async function verifyLabel(
  imageBytes: Buffer,
  declared: DeclaredFields,
  opts: VerifyOptions = {},
): Promise<VerifyResponse> {
  const startTotal = performance.now();
  const visionTimeoutMs = opts.visionTimeoutMs ?? DEFAULT_VISION_TIMEOUT_MS;

  // ─── 1. Preprocess ───────────────────────────────────────────────────────
  const preStart = performance.now();
  const pre = await preprocessImage(imageBytes);
  const preElapsed = performance.now() - preStart;

  // ─── 2. OCR + vision in parallel ─────────────────────────────────────────
  const ctrl = new AbortController();
  const timeoutHandle = setTimeout(() => ctrl.abort(), visionTimeoutMs);

  const extractor =
    opts.extractor ?? buildDefaultExtractor();

  // OCR may finish first; if it does, we hand its text to the vision call.
  // If it doesn't, the vision call goes without (C1 degenerates to T6).
  let ocrText: string | undefined;
  let ocrWords: OcrWord[] | undefined;
  let ocrElapsed: number | null = null;

  const ocrPromise: Promise<OcrResult | null> = tesseractEngine
    .run(pre.buffer, ctrl.signal)
    .then((r) => {
      ocrText = r.text;
      ocrWords = r.words;
      ocrElapsed = r.latencyMs;
      return r;
    })
    .catch(() => null);

  // Race a short window so OCR can deliver hint text if it's fast enough.
  // 1.5s is empirically about Tesseract's P50 on a 1600px label on Vercel.
  await Promise.race([
    ocrPromise,
    new Promise((resolve) => setTimeout(resolve, 1500)),
  ]);

  const visionCtx: ExtractorContext = {
    ocrText,
    ocrWords,
    signal: ctrl.signal,
  };

  let extracted: ExtractorResult;
  try {
    extracted = await extractor.extract(pre.buffer, visionCtx);
  } finally {
    clearTimeout(timeoutHandle);
  }

  // ─── 3. Match per-field ──────────────────────────────────────────────────
  const matchStart = performance.now();
  const f = extracted.fields;
  const brand = compareBrand(declared.brand_name, f.brand_name.value);
  const cls = compareClass(declared.class_type, f.class_type.value, f.class_type.confidence);
  const abv = compareAbv(
    declared.abv_percent,
    declared.class_category,
    f.abv_percent.value,
    f.abv_percent.confidence,
  );
  const nc = compareNetContents(
    declared.net_contents,
    f.net_contents.value,
    f.net_contents.confidence,
  );
  const producer = compareProducer(
    declared.producer,
    f.producer.value,
    f.producer.confidence,
  );
  const country = compareCountry(
    declared.country_of_origin,
    f.country_of_origin.value,
    f.country_of_origin.confidence,
  );

  // ─── 4. Government Warning ───────────────────────────────────────────────
  const gov = validateGovernmentWarning({
    extracted: f.government_warning.value ?? {
      raw_text: null,
      prefix_text: null,
      prefix_bbox: null,
      prefix_appears_bold: null,
      prefix_appears_caps: null,
    },
    declaredNetContents: declared.net_contents,
    imageDimsPx: { width: pre.width, height: pre.height },
  });
  const matchElapsed = performance.now() - matchStart;

  // ─── 5. Aggregate verdict + image quality ────────────────────────────────
  const fieldResults = [brand, cls, abv, nc, producer, country];

  // VERDICT (compliance): worst field status + Gov Warning subscore.
  const verdict: Verdict = aggregateVerdict([
    ...fieldResults.map((r) => r.status),
    gov.status,
  ]);

  // IMAGE QUALITY (independent): driven by the extractor's per-field
  // confidence aggregate, not by the verdict. This is the critical UX
  // distinction — see UI-SPEC §2.2.
  const fieldConfidences = [
    f.brand_name.confidence,
    f.class_type.confidence,
    f.abv_percent.confidence,
    f.net_contents.confidence,
    f.producer.confidence,
    f.country_of_origin.confidence,
    f.government_warning.confidence,
  ];
  const meanConf =
    fieldConfidences.reduce((s, x) => s + x, 0) / fieldConfidences.length;
  const minConf = Math.min(...fieldConfidences);
  const imageQuality: ImageQuality =
    minConf < 0.3 ? "bad" : meanConf < 0.6 ? "low" : "good";
  const imageQualityReason =
    imageQuality === "good"
      ? undefined
      : `Mean extractor confidence ${meanConf.toFixed(2)} (min ${minConf.toFixed(2)}).`;

  const totalMs = performance.now() - startTotal;

  const response: VerifyResponse = {
    verdict,
    imageQuality,
    fields: {
      brand_name: brand,
      class_type: cls,
      abv_percent: abv,
      net_contents: nc,
      producer,
      country_of_origin: country,
    },
    governmentWarning: gov,
    extracted: f,
    timings: {
      preprocess: round(preElapsed),
      ocr: ocrElapsed === null ? null : round(ocrElapsed),
      vision: round(extracted.latencyMs),
      matching: round(matchElapsed),
      total: round(totalMs),
    },
    modelId: extracted.modelId,
    modelVersion: extracted.modelVersion,
    ...(imageQualityReason ? { imageQualityReason } : {}),
  };
  return response;
}

function aggregateVerdict(statuses: ("pass" | "fail" | "review")[]): Verdict {
  if (statuses.includes("fail")) return "fail";
  if (statuses.includes("review")) return "review";
  return "pass";
}

function round(n: number): number {
  return Math.round(n);
}

let cachedExtractor: GeminiFlashExtractor | null = null;
function buildDefaultExtractor(): GeminiFlashExtractor {
  if (cachedExtractor) return cachedExtractor;
  const apiKey = process.env.GOOGLE_API_KEY;
  if (!apiKey) {
    throw new Error(
      "verifyLabel: GOOGLE_API_KEY is not set. Set it in .env.local or the Vercel project settings.",
    );
  }
  cachedExtractor = new GeminiFlashExtractor({
    apiKey,
    modelVersion: process.env.MODEL_PRIMARY ?? undefined,
  });
  return cachedExtractor;
}
