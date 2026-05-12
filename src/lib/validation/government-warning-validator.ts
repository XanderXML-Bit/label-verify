import type { ExtractedGovernmentWarning, NetContents } from "../vision/types";
import type { OcrWord } from "../ocr";
import {
  GOVERNMENT_WARNING_BODY,
  PREFIX_BOLD_TARGET,
  PREFIX_FULL,
  SEPARATOR_BETWEEN_PREFIX_AND_BODY,
  MIN_TYPE_HEIGHT_MM_LARGE,
  MIN_TYPE_HEIGHT_MM_SMALL,
  SMALL_CONTAINER_THRESHOLD_ML,
  BOLD_RATIO_PASS,
  BOLD_RATIO_FAIL,
  type GovernmentWarningCheck,
  type SubscoreResult,
  type SubscoreStatus,
  aggregateStatus,
  isPrefixAllCaps,
  normalizeForTextMatch,
  canonicalStatement,
} from "./government-warning";
import { toMl } from "../matching/net-contents";
import {
  findPrefixWords,
  findBodyWords,
  measureRelativeBold,
  measureSizeMm,
  type BoldMeasurement,
  type SizeMeasurement,
} from "./bold-size";

/**
 * Optional OCR context. When supplied, the bold + size subscores use
 * Tesseract word bboxes (pixel-tight) instead of the vision model's noisy
 * self-reported `prefix_bbox`. See `bold-size.ts`.
 *
 * Callers that don't have OCR available (e.g. unit tests that exercise the
 * legacy code path) can omit this field; the validator falls back to the
 * model's self-reported flags.
 */
export interface ValidatorOcrContext {
  words: OcrWord[];
  imageBuffer: Buffer;
}

/**
 * The Government Warning validator. Splits R5 into four subscores
 * (text / caps / bold / size) and aggregates with the worst-status rule.
 *
 * Inputs:
 *  - `extracted`: what the vision model reported it saw.
 *  - `declaredNetContents`: needed to pick the §16.22 type-size minimum
 *    (1 mm vs 2 mm).
 *  - `imageDimsPx` and `prefix_bbox`: needed for the pixel→mm size check.
 *    If we can't infer a reliable pixel→mm conversion the size subscore
 *    returns REVIEW (better than a false PASS).
 *  - `ocrContext` (optional): Tesseract word-level OCR. When present, the
 *    bold and size subscores prefer OCR-derived measurements over the
 *    model's self-reported `prefix_bbox` / `prefix_appears_bold`. The
 *    model's flag remains a fallback / corroboration signal.
 *
 * Failure modes the validator is built to catch are enumerated in
 * `docs/government-warning-cases.md`.
 */
export async function validateGovernmentWarning(input: {
  extracted: ExtractedGovernmentWarning;
  declaredNetContents: NetContents;
  imageDimsPx?: { width: number; height: number };
  ocrContext?: ValidatorOcrContext;
}): Promise<GovernmentWarningCheck> {
  const { extracted, declaredNetContents, imageDimsPx, ocrContext } = input;

  // If OCR is supplied, try to locate the prefix and (if possible) body
  // words once and share them between the bold and size subscores.
  let prefixWords: OcrWord[] = [];
  let bodyWords: OcrWord[] = [];
  let boldMeasurement: BoldMeasurement | null = null;
  let sizeMeasurement: SizeMeasurement | null = null;

  if (ocrContext && ocrContext.words.length > 0) {
    prefixWords = findPrefixWords(ocrContext.words);
    if (prefixWords.length > 0) {
      bodyWords = findBodyWords(ocrContext.words, prefixWords);
      if (bodyWords.length > 0) {
        boldMeasurement = await measureRelativeBold(
          ocrContext.imageBuffer,
          prefixWords,
          bodyWords,
        );
      }
      if (imageDimsPx) {
        sizeMeasurement = measureSizeMm(
          prefixWords,
          imageDimsPx,
          declaredNetContents,
        );
      }
    }
  }

  const text = scoreText(extracted.raw_text);
  const caps = scoreCaps(extracted.prefix_text);
  const bold = scoreBold(extracted.prefix_appears_bold, boldMeasurement);
  const size = scoreSize(
    extracted.prefix_bbox,
    imageDimsPx,
    declaredNetContents,
    sizeMeasurement,
  );

  const status = aggregateStatus([text.status, caps.status, bold.status, size.status]);
  const confidence = Math.min(
    text.confidence,
    caps.confidence,
    bold.confidence,
    size.confidence,
  );

  let reason: string | undefined;
  if (status !== "pass") {
    const failed: string[] = [];
    if (text.status !== "pass") failed.push(`text=${text.status}`);
    if (caps.status !== "pass") failed.push(`caps=${caps.status}`);
    if (bold.status !== "pass") failed.push(`bold=${bold.status}`);
    if (size.status !== "pass") failed.push(`size=${size.status}`);
    reason = `Government Warning subscores: ${failed.join(", ")}.`;
  }

  return {
    status,
    confidence,
    subscores: { text, caps, bold, size },
    reason,
  };
}

// ─── text subscore ──────────────────────────────────────────────────────────

function scoreText(raw: string | null): SubscoreResult {
  if (!raw) {
    return {
      status: "fail",
      confidence: 1.0, // we are confident it is missing
    };
  }
  // Compare against the canonical full statement after normalization.
  const got = normalizeForTextMatch(raw);
  const want = normalizeForTextMatch(canonicalStatement());

  if (got === want) {
    return { status: "pass", confidence: 1.0 };
  }

  // Maybe the extractor returned only the body. Try that.
  const wantBody = normalizeForTextMatch(GOVERNMENT_WARNING_BODY);
  if (got === wantBody) {
    return { status: "pass", confidence: 0.95 };
  }

  // Allow the prefix without colon if everything else is right (regulation
  // requires the colon, so this is a FAIL — but we flag confidence higher
  // because we want the reviewer to see it).
  const wantNoColon = normalizeForTextMatch(
    PREFIX_BOLD_TARGET + SEPARATOR_BETWEEN_PREFIX_AND_BODY + GOVERNMENT_WARNING_BODY,
  );
  if (got === wantNoColon) {
    return {
      status: "fail",
      confidence: 1.0,
    };
  }

  // Look for the prefix prefix at all. If neither prefix variant is present,
  // it's a hard fail; if present, the body diverges — still a fail.
  const hasPrefix = got.includes(normalizeForTextMatch(PREFIX_FULL));
  return {
    status: "fail",
    confidence: hasPrefix ? 1.0 : 0.9,
  };
}

// ─── caps subscore ──────────────────────────────────────────────────────────

function scoreCaps(prefixText: string | null): SubscoreResult {
  if (!prefixText) return { status: "fail", confidence: 1.0 };
  return isPrefixAllCaps(prefixText)
    ? { status: "pass", confidence: 1.0 }
    : { status: "fail", confidence: 1.0 };
}

// ─── bold subscore ──────────────────────────────────────────────────────────

/**
 * Three signals, in order of authority:
 *   1. OCR-derived stroke-width ratio (when confidence is non-zero) —
 *      authoritative, regulator-defensible.
 *   2. Model's self-reported `prefix_appears_bold` boolean — fallback.
 *   3. Neither available → REVIEW.
 *
 * The OCR signal can also COROBORATE the model flag: when both agree we
 * report higher confidence; when they disagree the worse signal wins.
 */
function scoreBold(
  appearsBold: boolean | null,
  ocr: BoldMeasurement | null,
): SubscoreResult {
  const ocrStatus = ocr && ocr.confidence > 0 ? ratioToStatus(ocr.ratio) : null;
  const modelStatus =
    appearsBold === true
      ? "pass"
      : appearsBold === false
        ? "fail"
        : ("review" as SubscoreStatus);

  if (ocrStatus !== null) {
    // OCR is the authoritative signal. If the model flag agrees, bump
    // confidence; if it disagrees, demote to the worse of the two
    // (never silently override OCR with a less-trustworthy model boolean,
    // but acknowledge the disagreement).
    if (appearsBold === null) {
      return { status: ocrStatus, confidence: ocr!.confidence };
    }
    if (modelStatus === ocrStatus) {
      // Agreement — bump confidence (capped at 0.95).
      return {
        status: ocrStatus,
        confidence: Math.min(0.95, ocr!.confidence + 0.15),
      };
    }
    // Disagreement: trust the worse of the two so we never silently pass
    // a borderline case the model called "not bold".
    const worst = aggregateStatus([ocrStatus, modelStatus]);
    return { status: worst, confidence: Math.max(0.3, ocr!.confidence - 0.1) };
  }

  // Fall back to the legacy model-only path.
  if (appearsBold === true) return { status: "pass", confidence: 0.7 };
  if (appearsBold === false) return { status: "fail", confidence: 0.7 };
  return { status: "review", confidence: 0.5 };
}

function ratioToStatus(ratio: number): SubscoreStatus {
  if (ratio >= BOLD_RATIO_PASS) return "pass";
  if (ratio < BOLD_RATIO_FAIL) return "fail";
  return "review";
}

// ─── size subscore ──────────────────────────────────────────────────────────

function scoreSize(
  bbox: ExtractedGovernmentWarning["prefix_bbox"],
  imageDimsPx: { width: number; height: number } | undefined,
  declaredNetContents: NetContents,
  ocrSize: SizeMeasurement | null,
): SubscoreResult {
  // Prefer OCR-derived prefix size when available — Tesseract word bboxes
  // are pixel-tight while the model's `prefix_bbox` is heuristic.
  if (ocrSize && imageDimsPx) {
    return sizeFromMm(ocrSize.prefixMm, ocrSize.minMm, 0.6);
  }

  if (!bbox || !imageDimsPx) {
    // No bbox, no image dims — we cannot estimate type size. REVIEW.
    return { status: "review", confidence: 0.4 };
  }
  // Pixel-to-mm conversion is approximate: we assume the long edge of the
  // image is roughly the height of the bottle's label, which for a typical
  // 750ml bottle is ~100mm. This is a v1 heuristic — Phase 3 refines it
  // by inferring label face from class + net-contents. The bbox reported
  // by a vision model is also approximate (it may be tighter than the
  // actual glyph bounds), so we use generous bands rather than strict
  // thresholds and prefer REVIEW over FAIL for borderline cases.
  const longEdgePx = Math.max(imageDimsPx.width, imageDimsPx.height);
  const assumedLabelHeightMm = labelHeightMmFor(declaredNetContents);
  const pxPerMm = longEdgePx / assumedLabelHeightMm;
  const prefixMm = bbox.height / pxPerMm;
  const isSmallContainer = toMl(declaredNetContents) <= SMALL_CONTAINER_THRESHOLD_ML;
  const minMm = isSmallContainer ? MIN_TYPE_HEIGHT_MM_SMALL : MIN_TYPE_HEIGHT_MM_LARGE;
  return sizeFromMm(prefixMm, minMm, 0.4);
}

/**
 * Apply the size threshold bands:
 *   - ≥ minMm * 0.8 → pass
 *   - ≥ minMm * 0.5 → review
 *   - else            fail
 */
function sizeFromMm(
  prefixMm: number,
  minMm: number,
  confidence: number,
): SubscoreResult {
  if (prefixMm >= minMm * 0.8) {
    return { status: "pass", confidence };
  }
  if (prefixMm >= minMm * 0.5) {
    return { status: "review", confidence };
  }
  return { status: "fail", confidence };
}

function labelHeightMmFor(nc: NetContents): number {
  const ml = toMl(nc);
  // Very rough: scale with container volume. 750ml ≈ 100mm label height
  // is a common front-label dimension.
  if (ml <= 50) return 30;
  if (ml <= 200) return 60;
  if (ml <= 375) return 80;
  if (ml <= 750) return 100;
  if (ml <= 1000) return 120;
  return 140;
}

// Re-export for convenience.
export type { SubscoreStatus, SubscoreResult } from "./government-warning";
