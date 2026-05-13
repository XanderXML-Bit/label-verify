import { describe, expect, it } from "vitest";
import { scoreImage, type GroundTruth } from "../../benchmarks/scorer";
import type { ExtractedFields } from "../../src/lib/vision/types";

const BODY =
  "(1) According to the Surgeon General, women should not drink alcoholic " +
  "beverages during pregnancy because of the risk of birth defects. " +
  "(2) Consumption of alcoholic beverages impairs your ability to drive a " +
  "car or operate machinery, and may cause health problems.";

const GT: GroundTruth = {
  id: "syn-beer-test",
  source: "synthetic",
  image: "test-data/labels/syn-beer-test.png",
  degradations: [],
  beverage_type: "beer",
  fields: {
    brand_name: "Cold Iron",
    class_type: "Pale Ale",
    class_category: "beer",
    abv_percent: 6.0,
    net_contents: { value: 355, unit: "ml" },
    producer: {
      name: "Cold Iron Beverage Co.",
      street: "310 River Rd",
      city: "Lexington",
      state: "KY",
      postal_code: "40508",
      country: "USA",
    },
    country_of_origin: "USA",
    government_warning: {
      present: true,
      text_matches_regulation: true,
      prefix_all_caps: true,
      prefix_bold: true,
      meets_size_minimum: true,
    },
  },
  gov_warning_case: null,
};

function perfectExtracted(): ExtractedFields {
  return {
    brand_name: { value: "Cold Iron", confidence: 0.95 },
    class_type: { value: "Pale Ale", confidence: 0.95 },
    abv_percent: { value: 6.0, confidence: 0.95 },
    net_contents: { value: { value: 355, unit: "ml" }, confidence: 0.95 },
    producer: {
      value: {
        name: "Cold Iron Beverage Co.",
        street: "310 River Rd",
        city: "Lexington",
        state: "KY",
        postal_code: "40508",
        country: "USA",
      },
      confidence: 0.95,
    },
    country_of_origin: { value: "USA", confidence: 0.95 },
    government_warning: {
      value: {
        raw_text: `GOVERNMENT WARNING: ${BODY}`,
        prefix_text: "GOVERNMENT WARNING:",
        // bbox large enough to clear the 2mm minimum at 1600x1200 with the
        // labelHeightMmFor(355ml)≈80mm scale → 1 px ≈ 0.05 mm, so ~50 px tall.
        prefix_bbox: { x: 100, y: 100, width: 400, height: 60 },
        prefix_appears_bold: true,
        prefix_appears_caps: true,
      },
      confidence: 0.95,
    },
  };
}

describe("scoreImage", () => {
  it("perfect extraction → all outcomes correct", async () => {
    const result = await scoreImage(GT, perfectExtracted(), {
      width: 1600,
      height: 1200,
    });
    const wrong = result.outcomes.filter((o) => !o.correct);
    expect(wrong).toEqual([]);
    // We expect one outcome per scored field: 6 normal + 1 gov_warning = 7.
    expect(result.outcomes.length).toBe(7);
    expect(result.warningOutcome.truthCompliant).toBe(true);
    expect(result.warningOutcome.predictedPass).toBe(true);
  });

  it("mutated brand → only brand_name flagged incorrect", async () => {
    const ext = perfectExtracted();
    ext.brand_name = { value: "Totally Different Brand", confidence: 0.95 };
    const result = await scoreImage(GT, ext, { width: 1600, height: 1200 });
    const wrong = result.outcomes.filter((o) => !o.correct).map((o) => o.field);
    expect(wrong).toEqual(["brand_name"]);
  });

  it("strata derived from synthetic-clean GT", async () => {
    const result = await scoreImage(GT, perfectExtracted(), {
      width: 1600,
      height: 1200,
    });
    expect(result.outcomes[0]?.strata.beverage_type).toBe("beer");
    expect(result.outcomes[0]?.strata.condition).toBe("clean");
    expect(result.outcomes[0]?.ood).toBe(false);
  });

  it("non-compliant GT + predicted-pass → warning outcome flags FN risk", async () => {
    // 2026-05-13 audit fix: truthCompliant is now derived from the 4
    // GW booleans, not from the gov_warning_case tag (which the audit
    // showed was sometimes overloaded with image-quality tags like
    // `Q4_LOW_LIGHT` that aren't actual compliance defects). To make
    // a label non-compliant, flip one of the four booleans.
    const failGt: GroundTruth = {
      ...GT,
      gov_warning_case: "T1",
      fields: {
        ...GT.fields,
        government_warning: {
          ...GT.fields.government_warning,
          text_matches_regulation: false,
        },
      },
    };
    const result = await scoreImage(failGt, perfectExtracted(), {
      width: 1600,
      height: 1200,
    });
    expect(result.warningOutcome.truthCompliant).toBe(false);
    expect(result.warningOutcome.predictedPass).toBe(true);
    // The field-level outcome for government_warning should be "incorrect"
    // because the predicted status ("pass") did not match truth ("fail").
    const govField = result.outcomes.find((o) => o.field === "government_warning");
    expect(govField?.correct).toBe(false);
  });
});
