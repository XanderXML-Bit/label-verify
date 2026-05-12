// Per-image scoring. Takes a GroundTruth + ExtractedFields and emits one
// PerItemOutcome per scored field, plus one PerItemWarningOutcome per image
// (the FN-rate aggregator in score.ts is keyed off the warning outcome).
//
// We reuse the production comparators in src/lib/matching/ + the validator in
// src/lib/validation/government-warning-validator.ts so the benchmark scores
// fields exactly the way the live verify pipeline scores them.

import {
  compareBrand,
  compareClass,
  compareAbv,
  compareNetContents,
  compareProducer,
  compareCountry,
  type ClassCategory,
} from "../src/lib/matching";
import { validateGovernmentWarning } from "../src/lib/validation/government-warning-validator";
import type { ExtractedFields, NetContents, ProducerAddress } from "../src/lib/vision/types";
import type { PerItemOutcome, PerItemWarningOutcome } from "./score";

// ─── Ground-truth shape ─────────────────────────────────────────────────────
//
// Documented in docs/CODEX-HANDOFF.md §3 and enforced by
// scripts/validate-corpus.ts. We re-declare the parts we need here so the
// scorer is self-contained.

export interface GroundTruthGovWarning {
  present: boolean;
  text_matches_regulation: boolean;
  prefix_all_caps: boolean;
  prefix_bold: boolean;
  meets_size_minimum: boolean;
}

export interface GroundTruthFields {
  brand_name: string;
  class_type: string;
  class_category: ClassCategory;
  abv_percent: number;
  net_contents: NetContents;
  producer: ProducerAddress | string;
  country_of_origin: string;
  government_warning: GroundTruthGovWarning;
}

export interface GroundTruth {
  id: string;
  source: "synthetic" | "degraded" | "real";
  image: string;
  degradations?: string[];
  beverage_type?: string;
  label_face?: string;
  container_size_ml?: number;
  fields: GroundTruthFields;
  /** Gov-Warning non-compliance taxonomy tag (T1/B1/C1/X1…) or null/undef = compliant. */
  gov_warning_case?: string | null;
  notes?: string;
}

// ─── Strata derivation ──────────────────────────────────────────────────────

/**
 * Derived condition tag for stratification. Per the task spec:
 *   - "clean" for synthetic with no degradations
 *   - the first degradation tag otherwise ("perspective:0.4" → "perspective")
 *   - "real" for source=real (collapses with the OOD flag)
 */
function deriveCondition(gt: GroundTruth): string {
  if (gt.source === "real") return "real";
  const degs = gt.degradations ?? [];
  if (degs.length === 0) return "clean";
  const first = degs[0] ?? "unknown";
  // strip ":0.4"-style intensity suffix so groups collapse sensibly.
  const colon = first.indexOf(":");
  return colon > 0 ? first.slice(0, colon) : first;
}

function strataFor(gt: GroundTruth): Record<string, string> {
  return {
    beverage_type: gt.beverage_type ?? "unknown",
    condition: deriveCondition(gt),
  };
}

// ─── Field-level scoring ────────────────────────────────────────────────────

export interface ScoredImage {
  outcomes: PerItemOutcome[];
  warningOutcome: PerItemWarningOutcome;
}

export function scoreImage(
  gt: GroundTruth,
  extracted: ExtractedFields,
  imageDimsPx?: { width: number; height: number },
): ScoredImage {
  const strata = strataFor(gt);
  const ood = gt.source === "real";
  const outcomes: PerItemOutcome[] = [];

  const push = (field: string, correct: boolean): void => {
    outcomes.push({ imageId: gt.id, field, correct, strata, ood });
  };

  const brand = compareBrand(gt.fields.brand_name, extracted.brand_name.value);
  push("brand_name", brand.status === "pass");

  const cls = compareClass(
    gt.fields.class_type,
    extracted.class_type.value,
    extracted.class_type.confidence,
  );
  push("class_type", cls.status === "pass");

  const abv = compareAbv(
    gt.fields.abv_percent,
    gt.fields.class_category,
    extracted.abv_percent.value,
    extracted.abv_percent.confidence,
  );
  push("abv_percent", abv.status === "pass");

  const nc = compareNetContents(
    gt.fields.net_contents,
    extracted.net_contents.value,
    extracted.net_contents.confidence,
  );
  push("net_contents", nc.status === "pass");

  const country = compareCountry(
    gt.fields.country_of_origin,
    extracted.country_of_origin.value,
    extracted.country_of_origin.confidence,
  );
  push("country_of_origin", country.status === "pass");

  const producer = compareProducer(
    gt.fields.producer,
    extracted.producer.value,
    extracted.producer.confidence,
  );
  push("producer", producer.status === "pass");

  // ─── Government Warning ────────────────────────────────────────────────────
  const gw = validateGovernmentWarning({
    extracted: extracted.government_warning.value ?? {
      raw_text: null,
      prefix_text: null,
      prefix_bbox: null,
      prefix_appears_bold: null,
      prefix_appears_caps: null,
    },
    declaredNetContents: gt.fields.net_contents,
    imageDimsPx,
  });

  // Field-level "correct" for the gov_warning column is "predicted status
  // matches ground-truth status": if gov_warning_case is null/absent the
  // truth status is "pass"; otherwise the truth status is "fail" (the
  // non-compliance taxonomy means the label should not pass).
  const truthCompliant = !gt.gov_warning_case;
  const truthStatus: "pass" | "fail" = truthCompliant ? "pass" : "fail";
  const predictedStatus = gw.status;
  push(
    "government_warning",
    (predictedStatus === "pass") === (truthStatus === "pass"),
  );

  const warningOutcome: PerItemWarningOutcome = {
    imageId: gt.id,
    truthCompliant,
    predictedPass: predictedStatus === "pass",
    strata,
    ood,
  };

  return { outcomes, warningOutcome };
}
