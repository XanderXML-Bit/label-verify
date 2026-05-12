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
  VerifyTrace,
} from "./types";
import type {
  ExtractedFields,
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
}

// Single production mode. No public/API-selectable modes: every verify and
// extract call uses the same Gemini Flash Lite primary path, with fallback only
// when the primary provider fails. Explicit `opts.extractor` and
// `opts.visionTimeoutMs` remain for tests and internal dependency injection.
const DEFAULT_VISION_TIMEOUT_MS = 60_000;
const PRODUCTION_MODE_ID = "default";

/**
 * Per-field confidence floor below which we defer to a human reviewer
 * rather than return PASS. Intelligence-first priority: if we can't be
 * certain, defer.
 *
 * Calibration history:
 *   - 2026-05-11: Started at 0.75 (mid of empirical dead zone).
 *   - 2026-05-12 (morning): User observed over-deferral — many "borderline"
 *     extractions turned out to be correct, so deferring them to
 *     a human costs more than the safety it bought. Dropped to 0.55.
 *   - 2026-05-12 (afternoon): Formal calibration against the 170-image
 *     combined corpus via `scripts/calibrate-review-threshold.ts`.
 *     Findings (.review/threshold-calibration-report.md):
 *       · 22 of 170 images have a base-PASS verdict (the others FAIL/REVIEW
 *         on a comparator before τ gets a chance to fire).
 *       · Of those 22: 16 are truly compliant, 6 have a wrong-PASS lurking
 *         (the comparator passed an incorrect extraction).
 *       · loss(τ) is FLAT at 30 (= 6 MWP × 5 weight, 0 FPD) across
 *         τ ∈ [0.30, 0.90]. The threshold doesn't fire for any of those
 *         6 wrong PASSes because the model was confidently wrong, not
 *         borderline wrong.
 *       · τ ≥ 0.91 adds 3 false-positive defers without catching any
 *         additional wrong PASSes — strict loss increase.
 *       · 0.55 is therefore on the Pareto plateau; no change.
 *     Catching the remaining 6 wrong PASSes needs a different
 *     intervention (second-opinion vision call, tighter comparator
 *     gating) — not a threshold tweak. Tracked in REMAINING-IMPROVEMENTS A8.
 *
 * Per-field comparators (ABV, net-contents, etc.) still apply their own
 * field-specific thresholds. This is a *second-layer* floor that catches
 * cases where the comparator returned PASS but the underlying extractor
 * confidence is borderline.
 */
export const REVIEW_CONFIDENCE_THRESHOLD = 0.55;

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

  const modeUsed = PRODUCTION_MODE_ID;
  const extractor = opts.extractor ?? buildDefaultExtractor();

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
  let fallbackUsed: string | null = null;
  try {
    try {
      extracted = await extractor.extract(pre.buffer, visionCtx);
    } catch (primaryErr) {
      // Primary vision provider is unreachable / 5xx / rate-limited /
      // timed out. Try a cross-provider fallback (GPT-5.4-nano via the
      // OpenAI SDK) if its key is wired. The fallback runs against the
      // SAME image and prompt, so the response shape is identical and
      // the rest of the pipeline doesn't know the difference — except
      // for the `fallbackUsed` flag we surface on the response so the
      // UI can render a "verified via backup" banner.
      const fallbackKey = process.env.OPENAI_API_KEY;
      const fallbackModel = process.env.MODEL_FALLBACK ?? "gpt-5.4-nano";
      if (!fallbackKey) {
        throw primaryErr;
      }
      // SECURITY: don't reuse the primary controller's signal — it has
      // probably already aborted (which is why the primary call threw).
      // Reusing it would either short-circuit the fallback to an
      // immediate AbortError OR let the fallback run unbounded
      // depending on the SDK. Allocate a fresh controller with the
      // remaining budget (capped at 25s so we stay under the Vercel
      // Hobby 30s function timeout even when the primary burned most
      // of the original budget). 2026-05-12 security audit finding #4.
      const remainingMs = Math.min(
        25_000,
        Math.max(5_000, visionTimeoutMs - (performance.now() - startTotal)),
      );
      const fbCtrl = new AbortController();
      const fbTimer = setTimeout(() => fbCtrl.abort(), remainingMs);
      const fallbackCtx: ExtractorContext = {
        ocrText,
        ocrWords,
        signal: fbCtrl.signal,
      };
      try {
        const mod = await import("./vision/openai");
        const fallbackExtractor = new mod.GPT4oMiniExtractor({
          apiKey: fallbackKey,
          modelVersion: fallbackModel,
        });
        extracted = await fallbackExtractor.extract(pre.buffer, fallbackCtx);
        fallbackUsed = fallbackModel;
      } catch {
        // Both providers failed. Surface the primary error — it's more
        // diagnostic than the fallback (the user can fix the primary,
        // the fallback is best-effort).
        throw primaryErr;
      } finally {
        clearTimeout(fbTimer);
      }
    }
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
  // Bounded await: if Tesseract's still running well past the vision
  // call, we'd rather ship a vision-only Gov-Warning verdict than hang
  // until the function timeout (Vercel Hobby caps at 30s). 8s is plenty
  // for a fully warm worker to finish recognising a single label; a
  // cold worker that hasn't finished by then almost certainly won't in
  // the remaining budget. The .catch(()=>null) in ocrPromise's
  // construction makes the timeout-loser harmless to the rest of the
  // pipeline. See Vercel-deploy postmortem 2026-05-12.
  const ocrFinal = await Promise.race([
    ocrPromise,
    new Promise<null>((resolve) => setTimeout(() => resolve(null), 8_000)),
  ]);
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
  // NOTE: loop variable renamed from `f` to `cmp` so it doesn't shadow
  // the outer `const f = extracted.fields` reference further down. Per
  // code review finding #12 — the shadowing was a maintainability
  // landmine even though TypeScript's block scoping happened to keep
  // current call sites correct.
  const reviewReasons: string[] = [];
  for (const cmp of fieldResults) {
    if (
      cmp.status === "pass" &&
      cmp.confidence < REVIEW_CONFIDENCE_THRESHOLD
    ) {
      const label = FIELD_LABEL[cmp.field] ?? cmp.field;
      reviewReasons.push(
        `${label} confidence ${cmp.confidence.toFixed(2)} below ${REVIEW_CONFIDENCE_THRESHOLD} — extractor could not confidently read this field from the label.`,
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
  for (const cmp of fieldResults) {
    if (cmp.status === "review") {
      const label = FIELD_LABEL[cmp.field] ?? cmp.field;
      reviewReasons.push(
        `${label} returned REVIEW${cmp.reason ? ` — ${cmp.reason}` : ""}`,
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
    ...(fallbackUsed ? { fallbackUsed } : {}),
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

// ─── extractOnly — application-data-free path ──────────────────────────────
//
// Same preprocess + OCR + vision pipeline as verifyLabel(), but stops
// after extraction. Used by /api/extract for the "show me what's on the
// label without an application" UX (per user direction 2026-05-11). We
// still surface modeId/modelVersion/timings so the result panel can
// render the same diagnostics block, and we still compute the
// image-quality flag so the reviewer sees the confidence pulse — there
// is just no PASS/FAIL/REVIEW verdict because we have nothing to
// compare against.

export interface ExtractOnlyResponse {
  extracted: ExtractedFields;
  imageQuality: ImageQuality;
  imageQualityReason?: string;
  governmentWarning: import("./types").VerifyResponse["governmentWarning"];
  timings: {
    preprocess: number;
    ocr: number | null;
    vision: number;
    matching: number;
    total: number;
  };
  modelId: string;
  modelVersion: string;
  modeUsed: string;
  fallbackUsed?: string;
  /** Always present: tells the UI to show the no-application banner. */
  note: string;
}

export async function extractOnly(
  imageBytes: Buffer,
  opts: VerifyOptions = {},
): Promise<ExtractOnlyResponse> {
  const startTotal = performance.now();
  const visionTimeoutMs = opts.visionTimeoutMs ?? DEFAULT_VISION_TIMEOUT_MS;

  const preStart = performance.now();
  const pre = await preprocessImage(imageBytes);
  const preElapsed = performance.now() - preStart;

  const ctrl = new AbortController();
  const timeoutHandle = setTimeout(() => ctrl.abort(), visionTimeoutMs);

  const modeUsed = PRODUCTION_MODE_ID;
  const extractor = opts.extractor ?? buildDefaultExtractor();

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
  let fallbackUsed: string | null = null;
  try {
    try {
      extracted = await extractor.extract(pre.buffer, visionCtx);
    } catch (primaryErr) {
      const fallbackKey = process.env.OPENAI_API_KEY;
      const fallbackModel = process.env.MODEL_FALLBACK ?? "gpt-5.4-nano";
      if (!fallbackKey) throw primaryErr;
      const remainingMs = Math.min(
        25_000,
        Math.max(5_000, visionTimeoutMs - (performance.now() - startTotal)),
      );
      const fbCtrl = new AbortController();
      const fbTimer = setTimeout(() => fbCtrl.abort(), remainingMs);
      try {
        const mod = await import("./vision/openai");
        const fallbackExtractor = new mod.GPT4oMiniExtractor({
          apiKey: fallbackKey,
          modelVersion: fallbackModel,
        });
        extracted = await fallbackExtractor.extract(pre.buffer, {
          ocrText,
          ocrWords,
          signal: fbCtrl.signal,
        });
        fallbackUsed = fallbackModel;
      } catch {
        throw primaryErr;
      } finally {
        clearTimeout(fbTimer);
      }
    }
  } finally {
    clearTimeout(timeoutHandle);
  }

  // Government Warning still validated — regulator-mandated text is a
  // SELF-CONTAINED check (federal regulation, not application-derived).
  // We can deliver a useful answer for that field even without app data.
  const matchStart = performance.now();
  // Bounded await: if Tesseract's still running well past the vision
  // call, we'd rather ship a vision-only Gov-Warning verdict than hang
  // until the function timeout (Vercel Hobby caps at 30s). 8s is plenty
  // for a fully warm worker to finish recognising a single label; a
  // cold worker that hasn't finished by then almost certainly won't in
  // the remaining budget. The .catch(()=>null) in ocrPromise's
  // construction makes the timeout-loser harmless to the rest of the
  // pipeline. See Vercel-deploy postmortem 2026-05-12.
  const ocrFinal = await Promise.race([
    ocrPromise,
    new Promise<null>((resolve) => setTimeout(() => resolve(null), 8_000)),
  ]);
  const f = extracted.fields;
  const gov = await validateGovernmentWarning({
    extracted: f.government_warning.value ?? {
      raw_text: null,
      prefix_text: null,
      prefix_bbox: null,
      prefix_appears_bold: null,
      prefix_appears_caps: null,
    },
    declaredNetContents: { value: 12, unit: "fl_oz" }, // placeholder
    imageDimsPx: { width: pre.width, height: pre.height },
    ocrContext:
      ocrFinal && ocrFinal.words.length > 0
        ? { words: ocrFinal.words, imageBuffer: pre.buffer }
        : undefined,
  });
  const matchElapsed = performance.now() - matchStart;

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

  return {
    extracted: f,
    imageQuality,
    governmentWarning: gov,
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
    note:
      "Application data was not provided. Extracted fields are shown for reference only — no PASS/FAIL/REVIEW verdict against declared values. The Government Warning subscore is still computed (federal regulation, not application-derived).",
    ...(imageQualityReason ? { imageQualityReason } : {}),
    ...(fallbackUsed ? { fallbackUsed } : {}),
  };
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
    // Surface a maximally helpful message: this is the #1 deployment
    // pitfall — the user copies the repo, deploys to Vercel, and forgets
    // to add the env var. Make the next step obvious.
    throw new Error(
      "GOOGLE_API_KEY is not set in the server environment. " +
        "Add it as an Environment Variable in your Vercel project " +
        "(Settings → Environment Variables → add GOOGLE_API_KEY for " +
        "Production + Preview + Development) and redeploy. " +
        "See docs/DEPLOYMENT-CHECKLIST.md §2.",
    );
  }
  cachedExtractor = new GeminiFlashExtractor({ apiKey });
  return cachedExtractor;
}
