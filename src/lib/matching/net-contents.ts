import type { NetContents } from "../vision/types";
import type { FieldComparison } from "./index";

// Conversion factors to ml.
const TO_ML: Record<NetContents["unit"], number> = {
  ml: 1,
  cl: 10,
  L: 1000,
  fl_oz: 29.5735, // US customary fluid ounce
};

/** Acceptable rounding band on the ml conversion (TEST-STRATEGY §7). */
const ML_TOLERANCE = 1.5;

export function toMl(nc: NetContents): number {
  return nc.value * TO_ML[nc.unit];
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
  const pass = Math.abs(dMl - eMl) <= ML_TOLERANCE;
  // Floor bumped from 0.60 → 0.70 to align with the intelligence-first
  // deferral policy in verify.ts: when the extractor isn't confident,
  // prefer a human reviewer over a possibly-wrong PASS.
  const review = pass && extractedConfidence < 0.7;
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
  };
}
