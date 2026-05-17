import type { NetContents } from "../vision/types";
import type { FieldComparison } from "./index";

// Conversion factors to ml.
const TO_ML: Record<NetContents["unit"], number> = {
  ml: 1,
  cl: 10,
  L: 1000,
  fl_oz: 29.5735, // US customary fluid ounce
};

/**
 * Acceptable rounding band on the ml conversion. The floor is 1.5 ml
 * (preserves the original tight pass on 12 fl oz / 355 ml rounding); for
 * larger containers we scale to ~0.5% so a 1.5 L bottle gets ±7.5 ml of
 * slack rather than the unrealistic ±1.5 ml the original constant gave.
 * See TEST-STRATEGY §7.
 */
const ML_TOLERANCE_BASE = 1.5;
function mlTolerance(refMl: number): number {
  return Math.max(ML_TOLERANCE_BASE, refMl * 0.005);
}

export function toMl(nc: NetContents): number {
  return nc.value * TO_ML[nc.unit];
}

/**
 * Approximate label-face height in mm given the declared net contents.
 * Used by the Government Warning size subscore (and the corpus
 * generator) to convert pixel heights to physical mm. Very rough heuristic
 * — see government-warning-validator.ts §size for the caveats.
 */
export function labelHeightMmFor(nc: NetContents): number {
  const ml = toMl(nc);
  if (ml <= 50) return 30;
  if (ml <= 200) return 60;
  if (ml <= 375) return 80;
  if (ml <= 750) return 100;
  if (ml <= 1000) return 120;
  return 140;
}

export function compareNetContents(
  declared: NetContents,
  extracted: NetContents | null,
  extractedConfidence: number,
): FieldComparison {
  if (!extracted) {
    return {
      field: "net_contents",
      status: "fail",
      expected: declared,
      actual: null,
      confidence: 0,
      reason: "No net contents found on the label.",
    };
  }
  const dMl = toMl(declared);
  const eMl = toMl(extracted);
  const tol = mlTolerance(Math.max(dMl, eMl));
  const deltaMl = Math.abs(dMl - eMl);
  const pass = deltaMl <= tol;
  // Floor bumped from 0.60 → 0.70 to align with the intelligence-first
  // deferral policy in verify.ts: when the extractor isn't confident,
  // prefer a human reviewer over a possibly-wrong PASS.
  const review = pass && extractedConfidence < 0.7;
  // Wave-35 Track 1 #1: emit passReason when the PASS was non-trivial
  // (any non-zero ml delta, or a unit conversion was involved — e.g.
  // 12 fl oz declared vs 355 ml extracted). Trivial same-unit-same-
  // value PASSes get no passReason.
  const unitConversionInvolved = declared.unit !== extracted.unit;
  const passReason: string | undefined =
    pass && !review && (deltaMl > 0 || unitConversionInvolved)
      ? unitConversionInvolved
        ? `Unit conversion accepted: declared ${declared.value} ${declared.unit} (${dMl.toFixed(1)} ml) vs printed ${extracted.value} ${extracted.unit} (${eMl.toFixed(1)} ml) — within the ±${tol.toFixed(1)} ml rounding band.`
        : `Rounding accepted: declared ${declared.value} ${declared.unit} vs printed ${extracted.value} ${extracted.unit} — off by ${deltaMl.toFixed(1)} ml, within the ±${tol.toFixed(1)} ml allowance.`
      : undefined;
  return {
    field: "net_contents",
    status: review ? "review" : pass ? "pass" : "fail",
    expected: declared,
    actual: extracted,
    confidence: extractedConfidence,
    reason: pass
      ? review
        ? "Net contents match within rounding band but extractor confidence is low."
        : undefined
      : `Declared ${declared.value} ${declared.unit} (${dMl.toFixed(1)} ml) vs printed ${extracted.value} ${extracted.unit} (${eMl.toFixed(1)} ml).`,
    ...(passReason ? { passReason } : {}),
  };
}
