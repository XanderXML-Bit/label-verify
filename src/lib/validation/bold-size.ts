// OCR-driven bold + size measurement for the Government Warning prefix.
//
// The vision model's self-reported `prefix_bbox` is approximate and noisy.
// Tesseract emits word-level bboxes that are pixel-tight: this module uses
// them to derive a far more reliable px-height for the §16.22 size check
// and to estimate a relative stroke-width ratio for the bold subscore.
//
// See docs/government-warning-cases.md for the B1–B4 / S1–S2 cases this
// module is designed to catch.

import sharp from "sharp";
import type { OcrWord } from "../ocr";
import type { NetContents } from "../vision/types";
import { labelHeightMmFor, toMl } from "../matching/net-contents";
import {
  MIN_TYPE_HEIGHT_MM_LARGE,
  MIN_TYPE_HEIGHT_MM_SMALL,
  SMALL_CONTAINER_THRESHOLD_ML,
} from "./government-warning";

// ─── Prefix-word location ────────────────────────────────────────────────────

/**
 * Normalize an OCR word string for prefix matching: NFKC-fold, strip
 * punctuation (the prefix may carry a trailing colon), uppercase.
 * Letter-shaped OCR errors get collapsed too: `0`→`O`, `1`→`I`, `5`→`S`,
 * `8`→`B`. These are the substitutions tesseract makes most often on the
 * large all-caps "GOVERNMENT WARNING" prefix.
 */
function normalizeWord(s: string): string {
  return s
    .normalize("NFKC")
    .toUpperCase()
    .replace(/[^A-Z0-9]/g, "")
    .replace(/0/g, "O")
    .replace(/1/g, "I")
    .replace(/5/g, "S")
    .replace(/8/g, "B");
}

const PREFIX_TOKENS = ["GOVERNMENT", "WARNING"] as const;

/**
 * Locate the OCR words that spell "GOVERNMENT WARNING". Tolerates a single
 * character of edit distance per token (so OCR slop like "G0VERNMENT" still
 * matches after the digit→letter fold). Returns the matched words in
 * reading order (GOVERNMENT first, then WARNING). May also include a
 * trailing colon token if it appears as a third word.
 *
 * Returns an empty array if neither token can be found with high confidence.
 */
export function findPrefixWords(words: OcrWord[]): OcrWord[] {
  if (!words || words.length === 0) return [];

  const norm = words.map((w) => normalizeWord(w.text));

  // Find a "GOVERNMENT"+"WARNING" pair that are close together (next-token
  // or one-token-apart in reading order).
  for (let i = 0; i < words.length; i++) {
    if (!matchesToken(norm[i]!, PREFIX_TOKENS[0])) continue;
    // Look ahead a few tokens for WARNING. Allow up to 2 tokens of slack
    // in case OCR introduces stray fragments between the two words.
    for (let j = i + 1; j <= Math.min(i + 3, words.length - 1); j++) {
      if (matchesToken(norm[j]!, PREFIX_TOKENS[1])) {
        // Roughly same y-band: the two words must share a baseline.
        const a = words[i]!.bbox;
        const b = words[j]!.bbox;
        const yOverlap = bandsOverlap(a.y, a.height, b.y, b.height, 0.5);
        if (!yOverlap) continue;
        return [words[i]!, words[j]!];
      }
    }
  }
  return [];
}

/** Token-level fuzzy match: equal after normalization, or edit-distance ≤ 1. */
function matchesToken(observed: string, target: string): boolean {
  if (observed === target) return true;
  if (Math.abs(observed.length - target.length) > 1) return false;
  return editDistance(observed, target) <= 1;
}

/** Classic Levenshtein, bounded by string lengths. */
function editDistance(a: string, b: string): number {
  if (a === b) return 0;
  if (a.length === 0) return b.length;
  if (b.length === 0) return a.length;
  const prev = new Array<number>(b.length + 1);
  const cur = new Array<number>(b.length + 1);
  for (let j = 0; j <= b.length; j++) prev[j] = j;
  for (let i = 1; i <= a.length; i++) {
    cur[0] = i;
    for (let j = 1; j <= b.length; j++) {
      const cost = a[i - 1] === b[j - 1] ? 0 : 1;
      cur[j] = Math.min(prev[j]! + 1, cur[j - 1]! + 1, prev[j - 1]! + cost);
    }
    for (let j = 0; j <= b.length; j++) prev[j] = cur[j]!;
  }
  return prev[b.length]!;
}

/**
 * True iff two y-bands [aY, aY+aH] and [bY, bY+bH] overlap by at least
 * `minFrac` of the smaller band's height. Use to enforce that the prefix
 * tokens share a baseline.
 */
function bandsOverlap(
  aY: number,
  aH: number,
  bY: number,
  bH: number,
  minFrac: number,
): boolean {
  const lo = Math.max(aY, bY);
  const hi = Math.min(aY + aH, bY + bH);
  const overlap = hi - lo;
  if (overlap <= 0) return false;
  const smaller = Math.min(aH, bH);
  return smaller > 0 && overlap / smaller >= minFrac;
}

// ─── Body-word location ──────────────────────────────────────────────────────

/**
 * Return body words that appear AFTER the prefix and plausibly belong to
 * the same Government Warning block. Heuristic:
 *   - word index > last prefix word's index, AND
 *   - word baseline (y center) lies within ~5 line-heights of the prefix
 *     baseline, AND
 *   - word x lies roughly under or to the right of the prefix x range.
 *
 * Caps at 60 body words — the regulation body is ~45 words.
 */
export function findBodyWords(
  words: OcrWord[],
  prefixWords: OcrWord[],
): OcrWord[] {
  if (prefixWords.length === 0 || words.length === 0) return [];

  const lastPrefixIdx = words.indexOf(prefixWords[prefixWords.length - 1]!);
  if (lastPrefixIdx < 0) return [];

  const prefixY = prefixWords[0]!.bbox.y;
  const prefixH =
    prefixWords.reduce((m, w) => Math.max(m, w.bbox.height), 0) || 1;
  const prefixXLo = Math.min(...prefixWords.map((w) => w.bbox.x));
  const prefixXHi = Math.max(
    ...prefixWords.map((w) => w.bbox.x + w.bbox.width),
  );
  // Allow body to drift left/right by the width of the prefix run itself.
  const xSlack = (prefixXHi - prefixXLo) * 0.5;
  const yMax = prefixY + prefixH * 8; // ~8 line-heights below the prefix
  const out: OcrWord[] = [];

  for (let i = lastPrefixIdx + 1; i < words.length && out.length < 60; i++) {
    const w = words[i]!;
    const cy = w.bbox.y + w.bbox.height / 2;
    if (cy < prefixY) continue; // above the prefix — different region
    if (cy > yMax) break; // far below the warning block — stop scanning
    if (
      w.bbox.x + w.bbox.width < prefixXLo - xSlack ||
      w.bbox.x > prefixXHi + xSlack
    ) {
      continue; // way off-column
    }
    // Skip tokens that are pure punctuation or empty after normalization.
    if (normalizeWord(w.text).length < 2) continue;
    out.push(w);
  }
  return out;
}

// ─── Relative stroke-width measurement ───────────────────────────────────────

export interface BoldMeasurement {
  /** prefix-mean stroke proxy ÷ body-mean stroke proxy. 1 = same weight. */
  ratio: number;
  /** 0–1 — combines sample size, contrast, and pixel-coverage robustness. */
  confidence: number;
  /**
   * Fraction of prefix words whose Tesseract `is_bold` flag was true (or
   * `null` when no prefix word had the flag set by the engine).
   * Used by the validator as a third corroboration signal.
   */
  fontBoldFractionPrefix: number | null;
  /** Same, body-side. */
  fontBoldFractionBody: number | null;
}

/**
 * For each word, crop the bbox, binarize, and compute the **per-column
 * average dark-run length** as a stroke-width proxy. Algorithm:
 *
 *   1. Crop the word bbox; greyscale + threshold to binary (dark = 1).
 *   2. For each column with at least one dark pixel, count the longest
 *      contiguous dark run (vertical stroke thickness at that column).
 *   3. Average those run lengths across columns with dark coverage.
 *
 * This is materially better than `dark / bboxHeight` (the legacy metric):
 *
 *   - Independent of bbox padding: a loose bbox no longer inflates the
 *     denominator and crushes the signal.
 *   - Independent of glyph aspect ratio: "I" vs "M" no longer skews the
 *     proxy by glyph width.
 *   - Captures stroke thickness directly: a Regular-weight glyph's
 *     vertical strokes are ~1px wide at typical render sizes; Bold is
 *     ~1.7×–2×. The ratio of column-mean-run-length between prefix
 *     and body is a clean weight-difference signal.
 *
 * The returned ratio is `mean(prefixProxy) / mean(bodyProxy)`, which is
 * the relative bold signal that 27 CFR § 16.21 demands.
 *
 * The image MUST be the same pixel buffer the OCR ran on, so the bboxes
 * are valid in the same coordinate space.
 */
export async function measureRelativeBold(
  image: Buffer,
  prefix: OcrWord[],
  body: OcrWord[],
): Promise<BoldMeasurement> {
  if (prefix.length === 0 || body.length === 0) {
    return {
      ratio: 1,
      confidence: 0,
      fontBoldFractionPrefix: null,
      fontBoldFractionBody: null,
    };
  }

  const sharpImg = sharp(image, { failOn: "none" });
  const meta = await sharpImg.metadata();
  const imgW = meta.width ?? 0;
  const imgH = meta.height ?? 0;
  if (imgW === 0 || imgH === 0) {
    return {
      ratio: 1,
      confidence: 0,
      fontBoldFractionPrefix: null,
      fontBoldFractionBody: null,
    };
  }

  const prefixProxies = await Promise.all(
    prefix.map((w) => strokeProxy(image, w, imgW, imgH)),
  );
  const bodyProxies = await Promise.all(
    body.map((w) => strokeProxy(image, w, imgW, imgH)),
  );

  const prefixValid = prefixProxies.filter((p): p is number => p !== null);
  const bodyValid = bodyProxies.filter((p): p is number => p !== null);

  if (prefixValid.length === 0 || bodyValid.length === 0) {
    return {
      ratio: 1,
      confidence: 0,
      fontBoldFractionPrefix: fontBoldFraction(prefix),
      fontBoldFractionBody: fontBoldFraction(body),
    };
  }

  const prefixMean = mean(prefixValid);
  const bodyMean = mean(bodyValid);
  if (bodyMean <= 0) {
    return {
      ratio: 1,
      confidence: 0,
      fontBoldFractionPrefix: fontBoldFraction(prefix),
      fontBoldFractionBody: fontBoldFraction(body),
    };
  }
  // The per-word proxy is `mean(longest-dark-run-per-column) / bboxHeight`.
  // This is already approximately render-size-invariant: at the same font
  // weight, doubling the render size doubles both the stroke run length
  // and the bbox height, so the proxy is unchanged. Therefore the ratio
  // of `meanProxy(prefix) / meanProxy(body)` is a clean WEIGHT signal,
  // not a size signal — no further size attenuation needed.
  const ratio = prefixMean / bodyMean;

  // Confidence: scales with sample size up to ~10 body words, capped at 0.9.
  // (We never claim full confidence — this is still a proxy, not a font lookup.)
  const sampleConf = Math.min(1, bodyValid.length / 10);
  const confidence = 0.5 + 0.4 * sampleConf;

  return {
    ratio,
    confidence,
    fontBoldFractionPrefix: fontBoldFraction(prefix),
    fontBoldFractionBody: fontBoldFraction(body),
  };
}

/**
 * Crop the word bbox, threshold-binarize, and compute the per-column
 * average **vertical dark-run length** — a clean stroke-thickness proxy.
 *
 * Returns null on degenerate crops (zero area, all one color, or fewer
 * than 2 columns with dark coverage — not enough signal).
 */
async function strokeProxy(
  image: Buffer,
  word: OcrWord,
  imgW: number,
  imgH: number,
): Promise<number | null> {
  // Clamp the crop to the image — sharp throws on out-of-bounds extracts.
  const x = Math.max(0, Math.floor(word.bbox.x));
  const y = Math.max(0, Math.floor(word.bbox.y));
  const w = Math.min(imgW - x, Math.max(1, Math.floor(word.bbox.width)));
  const h = Math.min(imgH - y, Math.max(1, Math.floor(word.bbox.height)));
  if (w < 2 || h < 2) return null;

  try {
    // Greyscale + fixed threshold at 128. (We intentionally skip
    // `normalize()` here: it destroys density information on already-
    // saturated crops — a thick all-black prefix glyph would get rescaled
    // to all-white before thresholding, zeroing the stroke proxy.)
    const { data, info } = await sharp(image, { failOn: "none" })
      .extract({ left: x, top: y, width: w, height: h })
      .greyscale()
      .threshold(128)
      .raw()
      .toBuffer({ resolveWithObject: true });
    const cols = info.width;
    const rows = info.height;
    if (cols === 0 || rows === 0) return null;

    // For each column, enumerate ALL contiguous dark runs (each run is a
    // stroke crossing). Sum total dark pixels and total run count across
    // all columns; the ratio `darkPixels / runCount` is **mean stroke
    // thickness** along the column axis — a true stroke-width proxy
    // (NOT cap-height, which is what `longest-run-per-column` measures).
    //
    // For Regular weight at the same render size, a horizontal stroke
    // crosses each column with a 1–2 px vertical run; for Bold, the same
    // stroke crosses with a 2–4 px run. Ratio of mean-run-length between
    // prefix and body cleanly separates the two weights.
    let totalDark = 0;
    let totalRuns = 0;
    let columnsWithDark = 0;
    for (let cx = 0; cx < cols; cx++) {
      let inRun = false;
      let columnHadDark = false;
      for (let cy = 0; cy < rows; cy++) {
        const dark = data[cy * cols + cx]! < 128;
        if (dark) {
          totalDark++;
          columnHadDark = true;
          if (!inRun) {
            totalRuns++;
            inRun = true;
          }
        } else {
          inRun = false;
        }
      }
      if (columnHadDark) columnsWithDark++;
    }
    if (columnsWithDark < 2 || totalRuns === 0) return null;
    // Mean dark-run length along columns = stroke thickness proxy.
    return totalDark / totalRuns;
  } catch {
    return null;
  }
}

function fontBoldFraction(words: OcrWord[]): number | null {
  const observed = words.filter((w) => typeof w.fontBold === "boolean");
  if (observed.length === 0) return null;
  const bold = observed.filter((w) => w.fontBold === true).length;
  return bold / observed.length;
}

function mean(xs: number[]): number {
  if (xs.length === 0) return 0;
  return xs.reduce((s, x) => s + x, 0) / xs.length;
}

// ─── OCR-driven size measurement ─────────────────────────────────────────────

export interface SizeMeasurement {
  /** Estimated glyph height of the prefix in millimeters. */
  prefixMm: number;
  /** §16.22 minimum for the declared container size (1mm or 2mm). */
  minMm: number;
  /** True if prefixMm ≥ minMm (no rounding band — caller may add one). */
  pass: boolean;
}

/**
 * Derive prefix glyph height in mm using the same px→mm heuristic as the
 * legacy size scorer (longest image edge ≈ assumed label face height for
 * the declared net contents). The IMPROVEMENT here: use the maximum
 * word-bbox height among the matched prefix OCR words instead of the
 * model's noisy `prefix_bbox.height`. Tesseract word bboxes are pixel-
 * tight glyph extents, so this is materially more accurate.
 */
export function measureSizeMm(
  prefix: OcrWord[],
  imageDimsPx: { width: number; height: number },
  declaredNetContents: NetContents,
): SizeMeasurement {
  const minMm = minTypeHeightMm(declaredNetContents);
  if (prefix.length === 0) {
    return { prefixMm: 0, minMm, pass: false };
  }
  const prefixPx = prefix.reduce((m, w) => Math.max(m, w.bbox.height), 0);
  const longEdgePx = Math.max(imageDimsPx.width, imageDimsPx.height);
  const assumedLabelHeightMm = labelHeightMmFor(declaredNetContents);
  const pxPerMm = longEdgePx / assumedLabelHeightMm;
  const prefixMm = pxPerMm > 0 ? prefixPx / pxPerMm : 0;
  return { prefixMm, minMm, pass: prefixMm >= minMm };
}

function minTypeHeightMm(nc: NetContents): number {
  return toMl(nc) <= SMALL_CONTAINER_THRESHOLD_ML
    ? MIN_TYPE_HEIGHT_MM_SMALL
    : MIN_TYPE_HEIGHT_MM_LARGE;
}

// labelHeightMmFor imported from ../matching/net-contents (single source).
