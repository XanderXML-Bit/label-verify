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
import { labelHeightMmFor, toMl } from "../matching/net-contents";
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

// Regulator-strict text comparison. We DO NOT relax to REVIEW on
// paraphrase-class differences: from text alone we cannot distinguish
// "model misread compliant label" from "label actually says X" — and
// 27 CFR §16.21 requires the exact regulatory text, so any deviation
// is a FAIL by the rule the reviewer must enforce. The model-misread
// case shows up at a layer above: it pulls the WHOLE verdict to
// REVIEW via the per-field-confidence deferral path (`REVIEW_
// CONFIDENCE_THRESHOLD` in verify.ts), where a human compares the
// printed label to the canonical text directly.
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
 *   1. OCR-derived mean-stroke-thickness ratio (when confidence is
 *      non-zero) — authoritative, regulator-defensible.
 *   2. Tesseract's per-word `is_bold` flag, when the engine emits it
 *      — corroboration only (treat as advisory, never as the only signal).
 *   3. Vision model's self-reported `prefix_appears_bold` boolean —
 *      fallback when OCR fails to locate the prefix and corroboration
 *      when it doesn't.
 *
 * "prefer_model" mode (implicit): when the OCR stroke metric is in the
 * REVIEW band (1.15 < ratio < 1.5) AND its confidence is low, we defer
 * to the model's report. When both OCR and model agree on FAIL, we
 * return FAIL with high confidence (corroborated finding).
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

  // Tesseract's per-word `is_bold` flag is unreliable on synthetic text
  // (often emits `false` even when the glyph is clearly bold) but on
  // real labels it's a credible third signal. When both prefix and body
  // expose it, we use the DIFFERENCE between fractions as a secondary
  // corroboration.
  const fontBoldStatus: SubscoreStatus | null = (() => {
    if (!ocr) return null;
    const p = ocr.fontBoldFractionPrefix;
    const b = ocr.fontBoldFractionBody;
    if (p === null || b === null) return null;
    // If most prefix words are flagged bold AND most body words are not,
    // that's a strong corroboration of "bold prefix".
    if (p >= 0.5 && b < 0.5) return "pass";
    // If neither side is flagged bold, or both are equally flagged,
    // that's a weak signal — could be a flag that Tesseract just isn't
    // emitting reliably for this build. Don't take it as fail unless the
    // body is MORE bold than the prefix (B2 inverse case).
    if (b > p + 0.3) return "fail";
    return null;
  })();

  if (ocrStatus !== null) {
    // OCR stroke metric is the primary authority. Fold in the font-bold
    // and model signals as corroboration.
    const signals: SubscoreStatus[] = [ocrStatus];
    if (fontBoldStatus !== null) signals.push(fontBoldStatus);
    if (modelStatus !== "review") signals.push(modelStatus);

    // Count agreement: how many signals match the OCR verdict?
    const agreeing = signals.filter((s) => s === ocrStatus).length;
    const corroborated = agreeing >= 2 && signals.length >= 2;

    // OCR pass: if model OR font-bold contradicts with "fail", and OCR
    // ratio is in the lower half of the pass band, drop to REVIEW.
    if (ocrStatus === "pass") {
      const ratio = ocr!.ratio;
      const inLowerPassBand = ratio < BOLD_RATIO_PASS + 0.2;
      const contradicted =
        (modelStatus === "fail" || fontBoldStatus === "fail") &&
        inLowerPassBand;
      if (contradicted) {
        return { status: "review", confidence: Math.max(0.4, ocr!.confidence - 0.2) };
      }
      return {
        status: "pass",
        confidence: corroborated
          ? Math.min(0.95, ocr!.confidence + 0.15)
          : ocr!.confidence,
      };
    }

    // OCR fail: if BOTH model and font-bold disagree (both say pass),
    // this is suspicious — drop to REVIEW so a human looks.
    if (ocrStatus === "fail") {
      const modelDisagrees = modelStatus === "pass";
      const fontBoldDisagrees = fontBoldStatus === "pass";
      if (modelDisagrees && fontBoldDisagrees) {
        return { status: "review", confidence: 0.4 };
      }
      // Corroborated fail = high-confidence FAIL.
      return {
        status: "fail",
        confidence: corroborated
          ? Math.min(0.95, ocr!.confidence + 0.15)
          : ocr!.confidence,
      };
    }

    // OCR review: defer to model when it's confident, otherwise stay review.
    if (modelStatus !== "review") {
      // prefer_model in the ambiguous OCR band.
      return { status: modelStatus, confidence: 0.55 };
    }
    return { status: "review", confidence: ocr!.confidence };
  }

  // No OCR signal — fall back to the model + font-bold (if available).
  if (fontBoldStatus !== null && modelStatus === fontBoldStatus) {
    // The font-bold signal alone, but corroborated by the model.
    // `fontBoldStatus` is only ever "pass" | "fail" (never "review")
    // per its construction above, so this is a 2-signal agreement.
    return { status: fontBoldStatus, confidence: 0.7 };
  }
  if (appearsBold === true) return { status: "pass", confidence: 0.6 };
  if (appearsBold === false) return { status: "fail", confidence: 0.6 };
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
 * Apply the size threshold bands. ADVISORY — the size subscore is the
 * weakest evidence on this validator: the pixel-to-mm conversion
 * assumes the long edge of the image equals the label face height for
 * the declared net contents, which has no aspect-ratio correction (a
 * cropped photo and a full-bottle photo of the same label can read out
 * very different `prefixMm`).
 *
 * Bands:
 *   - ≥ minMm * 0.8 → pass
 *   - else            review (never FAIL — see above)
 *
 * A genuinely too-small Gov Warning will FAIL on the text + caps + bold
 * subscores in most cases. Driving a FAIL purely from a pixel-height
 * estimate causes too many false-FAILs on the photo-realistic OOD
 * corpus. Documented as advisory in README + SECURITY.
 */
function sizeFromMm(
  prefixMm: number,
  minMm: number,
  confidence: number,
): SubscoreResult {
  if (prefixMm >= minMm * 0.8) {
    return { status: "pass", confidence };
  }
  return { status: "review", confidence: Math.min(confidence, 0.5) };
}

// labelHeightMmFor lives in src/lib/matching/net-contents.ts (single source).

// Re-export for convenience.
export type { SubscoreStatus, SubscoreResult } from "./government-warning";
