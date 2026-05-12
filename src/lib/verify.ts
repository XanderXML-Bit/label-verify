import { preprocessImage } from "./preprocess";
import { GeminiFlashExtractor } from "./vision/gemini";
import { tesseractEngine } from "./ocr/tesseract";
import { DEFAULT_MODE_ID, getMode } from "./model-modes";
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
  VerifyTrace,
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
  /**
   * Optional sink for a {@link VerifyTrace} describing this run. Invoked once
   * after the response is built. Default is no-op. Used by /api/debug/last to
   * populate the in-memory ring buffer; never affects the response.
   */
  recordTrace?: (trace: VerifyTrace) => void;
  /**
   * Optional model-mode ID (see lib/model-modes.ts). When provided and
   * recognised, the orchestrator builds the extractor via that mode's
   * factory. Falls through to `extractor` first (explicit beats mode) and
   * to `buildDefaultExtractor()` last. Unknown IDs are silently ignored:
   * the orchestrator must never 500 because the UI sent a stale mode.
   */
  modelMode?: string;
}

const DEFAULT_VISION_TIMEOUT_MS = 4500;

/**
 * Single source of truth for the per-field confidence floor below which we
 * defer to a human reviewer rather than return PASS. Intelligence-first
 * priority: if we can't be 100% certain, defer.
 *
 * Set to 0.75 because:
 *   - Empirically the Gemini Flash extractor reports ≥ 0.85 on clean labels
 *     and < 0.65 on the cases where it later turned out to be wrong. 0.75
 *     puts the cutoff in the middle of the dead zone.
 *   - Per-field comparators already downgrade to REVIEW at their own field-
 *     specific thresholds (ABV/net-contents at 0.7, brand by token-set, etc.).
 *     This is a *second-layer* floor that catches the cases where the
 *     comparator returned PASS but the underlying extractor confidence is
 *     borderline.
 */
export const REVIEW_CONFIDENCE_THRESHOLD = 0.75;

/** Pretty per-field labels for the `reviewReasons` strings. */
const FIELD_LABEL: Record<string, string> = {
  brand_name: "Brand name",
  class_type: "Class / type",
  abv_percent: "ABV",
  net_contents: "Net contents",
  producer: "Producer / address",
  country_of_origin: "Country of origin",
};

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

  // Extractor selection precedence:
  //   1. opts.extractor — explicit instance (tests, custom callers)
  //   2. opts.modelMode — selectable mode (Settings panel / API `mode` field)
  //   3. buildDefaultExtractor() — legacy MODEL_PRIMARY path
  // Unknown modeIds fall through to the legacy default so a stale
  // client-side value never breaks the request.
  let modeUsed: string = DEFAULT_MODE_ID;
  let extractor: Extractor;
  if (opts.extractor) {
    extractor = opts.extractor;
  } else if (opts.modelMode) {
    const mode = getMode(opts.modelMode);
    if (mode) {
      extractor = mode.extractorFactory();
      modeUsed = mode.id;
    } else {
      extractor = buildDefaultExtractor();
    }
  } else {
    extractor = buildDefaultExtractor();
  }

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
  // Wait for OCR to finish before validating: if it succeeded, the validator
  // uses Tesseract word bboxes (pixel-tight) for the bold + size subscores
  // instead of the vision model's noisy self-reported `prefix_bbox`.
  const ocrFinal = await ocrPromise;
  const gov = await validateGovernmentWarning({
    extracted: f.government_warning.value ?? {
      raw_text: null,
      prefix_text: null,
      prefix_bbox: null,
      prefix_appears_bold: null,
      prefix_appears_caps: null,
    },
    declaredNetContents: declared.net_contents,
    imageDimsPx: { width: pre.width, height: pre.height },
    ocrContext:
      ocrFinal && ocrFinal.words.length > 0
        ? { words: ocrFinal.words, imageBuffer: pre.buffer }
        : undefined,
  });
  const matchElapsed = performance.now() - matchStart;

  // ─── 5. Aggregate verdict + image quality ────────────────────────────────
  const fieldResults = [brand, cls, abv, nc, producer, country];

  // VERDICT (compliance): worst field status + Gov Warning subscore.
  let verdict: Verdict = aggregateVerdict([
    ...fieldResults.map((r) => r.status),
    gov.status,
  ]);

  // ─── 5a. Intelligence-first deferral ─────────────────────────────────────
  //
  // Catch the case where every field comparator returned PASS individually
  // but the underlying extractor confidence is borderline on one or more
  // fields. Per the product priority: never return PASS when any field is
  // borderline; route borderline cases to a human-review queue.
  //
  // FAIL is never downgraded to REVIEW — a clearly non-compliant label still
  // fails, regardless of confidence. Only PASS is at risk of being too
  // optimistic.
  const reviewReasons: string[] = [];
  for (const f of fieldResults) {
    if (
      f.status === "pass" &&
      f.confidence < REVIEW_CONFIDENCE_THRESHOLD
    ) {
      const label = FIELD_LABEL[f.field] ?? f.field;
      reviewReasons.push(
        `${label} confidence ${f.confidence.toFixed(2)} below ${REVIEW_CONFIDENCE_THRESHOLD} — extractor could not confidently read this field from the label.`,
      );
    }
  }
  // The Government Warning validator already returns REVIEW on borderline
  // bold; collect a human-readable reason when it does.
  if (gov.status === "review") {
    reviewReasons.push(
      `Government Warning subscore is REVIEW${gov.reason ? ` — ${gov.reason}` : ""}.`,
    );
  }
  // Per-field comparators that already returned REVIEW (e.g. ABV with low
  // extractor confidence, brand near-miss) also contribute a reason so the
  // reviewer sees the full picture in one place.
  for (const f of fieldResults) {
    if (f.status === "review") {
      const label = FIELD_LABEL[f.field] ?? f.field;
      reviewReasons.push(
        `${label} returned REVIEW${f.reason ? ` — ${f.reason}` : ""}`,
      );
    }
  }

  if (verdict === "pass" && reviewReasons.length > 0) {
    // Downgrade PASS → REVIEW. The reasons array is already populated.
    verdict = "review";
  }

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
    modeUsed,
    requiresHumanReview: verdict === "review",
    reviewReasons: verdict === "review" ? reviewReasons : [],
    ...(imageQualityReason ? { imageQualityReason } : {}),
  };

  // Hand the trace to the optional sink (used by /api/debug/last). Wrapped
  // in try/catch so an instrumentation bug can never break a real verify.
  if (opts.recordTrace) {
    try {
      opts.recordTrace({
        id: makeTraceId(),
        receivedAt: Date.now(),
        declared,
        preprocessedDims: { w: pre.width, h: pre.height },
        modelId: extracted.modelId,
        modelVersion: extracted.modelVersion,
        promptHash: extracted.promptHash,
        ocrText: ocrText ?? null,
        rawExtraction: extracted.rawOutput,
        response,
      });
    } catch {
      // Swallow — debug instrumentation must never affect the response.
    }
  }

  return response;
}

function makeTraceId(): string {
  // Short, URL-safe, sortable-by-creation: timestamp + random tail. Not a
  // cryptographic id — this is a debug breadcrumb, not a security boundary.
  const tail = Math.random().toString(36).slice(2, 8);
  return `${Date.now().toString(36)}-${tail}`;
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
