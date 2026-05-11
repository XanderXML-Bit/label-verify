import type { ExtractedGovernmentWarning, NetContents } from "../vision/types";
import {
  GOVERNMENT_WARNING_BODY,
  PREFIX_BOLD_TARGET,
  PREFIX_FULL,
  SEPARATOR_BETWEEN_PREFIX_AND_BODY,
  MIN_TYPE_HEIGHT_MM_LARGE,
  MIN_TYPE_HEIGHT_MM_SMALL,
  SMALL_CONTAINER_THRESHOLD_ML,
  type GovernmentWarningCheck,
  type SubscoreResult,
  aggregateStatus,
  isPrefixAllCaps,
  normalizeForTextMatch,
  canonicalStatement,
} from "./government-warning";
import { toMl } from "../matching/net-contents";

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
 *
 * Failure modes the validator is built to catch are enumerated in
 * `docs/government-warning-cases.md`.
 */
export function validateGovernmentWarning(input: {
  extracted: ExtractedGovernmentWarning;
  declaredNetContents: NetContents;
  imageDimsPx?: { width: number; height: number };
}): GovernmentWarningCheck {
  const { extracted, declaredNetContents, imageDimsPx } = input;

  const text = scoreText(extracted.raw_text);
  const caps = scoreCaps(extracted.prefix_text);
  const bold = scoreBold(extracted.prefix_appears_bold);
  const size = scoreSize(extracted.prefix_bbox, imageDimsPx, declaredNetContents);

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

function scoreBold(appearsBold: boolean | null): SubscoreResult {
  // For Phase 1 we trust the extractor's self-reported bold flag. Phase 3
  // upgrades this to a relative-stroke-width measurement on the prefix
  // bounding box (see ARCHITECTURE.md §3 step 5).
  if (appearsBold === true) return { status: "pass", confidence: 0.7 };
  if (appearsBold === false) return { status: "fail", confidence: 0.7 };
  // null = "I cannot tell" → REVIEW.
  return { status: "review", confidence: 0.5 };
}

// ─── size subscore ──────────────────────────────────────────────────────────

function scoreSize(
  bbox: ExtractedGovernmentWarning["prefix_bbox"],
  imageDimsPx: { width: number; height: number } | undefined,
  declaredNetContents: NetContents,
): SubscoreResult {
  if (!bbox || !imageDimsPx) {
    // No bbox, no image dims — we cannot estimate type size. REVIEW.
    return { status: "review", confidence: 0.4 };
  }
  // Pixel-to-mm conversion is approximate: we assume the long edge of the
  // image is roughly the height of the bottle's label, which for a typical
  // 750ml bottle is ~100mm. This is a v1 heuristic — Phase 3 refines it
  // by inferring label face from class + net-contents.
  const longEdgePx = Math.max(imageDimsPx.width, imageDimsPx.height);
  const assumedLabelHeightMm = labelHeightMmFor(declaredNetContents);
  const pxPerMm = longEdgePx / assumedLabelHeightMm;
  const prefixMm = bbox.height / pxPerMm;
  const isSmallContainer = toMl(declaredNetContents) <= SMALL_CONTAINER_THRESHOLD_ML;
  const minMm = isSmallContainer ? MIN_TYPE_HEIGHT_MM_SMALL : MIN_TYPE_HEIGHT_MM_LARGE;
  // Confidence reflects how rough the px-to-mm estimate is.
  const confidence = 0.6;
  if (prefixMm >= minMm) {
    return { status: "pass", confidence };
  }
  if (prefixMm >= minMm * 0.8) {
    // Within 20% of the floor — REVIEW, not FAIL.
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
