// Pre-populated sample labels for the "Try a sample" affordance on the
// home page. Each sample bundles a static image URL (served from
// public/samples/) and the declared application data that should
// accompany it. The images are sourced from the v2 corpus so a reviewer
// can immediately see an end-to-end verify result without having to
// hand-fill the form.

import type { DeclaredFields } from "./types";

export interface Sample {
  id: "pass" | "fail" | "review";
  label: string;
  shortDescription: string;
  imageUrl: string;
  declared: DeclaredFields;
  /** Expected verdict — set so the UI can show a "what to look for" hint. */
  expectedVerdict: "pass" | "fail" | "review";
  expectedNote: string;
}

export const SAMPLES: readonly Sample[] = [
  {
    id: "pass",
    label: "PASS sample",
    shortDescription: "Compliant beer label — every field should match.",
    imageUrl: "/samples/pass.png",
    expectedVerdict: "pass",
    expectedNote:
      "All seven regulated fields match the declared application data; Government Warning is fully compliant under 27 CFR §16.21.",
    declared: {
      brand_name: "Bluerose",
      class_type: "Pale Ale",
      class_category: "beer",
      abv_percent: 6.0,
      net_contents: { value: 200, unit: "ml" },
      producer: {
        name: "Bluerose Beverage Co.",
        street: "802 Harbor Way",
        city: "Portland",
        state: "ME",
        postal_code: "04101",
        country: "USA",
      },
      country_of_origin: "USA",
    },
  },
  {
    id: "fail",
    label: "FAIL sample",
    shortDescription:
      "Spirits label with title-case 'Government Warning:' prefix — must fail R5.",
    imageUrl: "/samples/fail.png",
    expectedVerdict: "fail",
    expectedNote:
      "The Government Warning prefix is rendered in title case ('Government Warning:'). 27 CFR §16.21 requires all caps; this is a strict regulatory failure.",
    declared: {
      brand_name: "Marrow & Bone",
      class_type: "Scotch Whisky",
      class_category: "distilled_spirits",
      abv_percent: 53.7,
      net_contents: { value: 750, unit: "ml" },
      producer: {
        name: "Marrow Bone Beverage Co.",
        street: "188 Quarry Pass",
        city: "Boise",
        state: "ID",
        postal_code: "83702",
        country: "USA",
      },
      country_of_origin: "USA",
    },
  },
  {
    id: "review",
    label: "REVIEW sample",
    shortDescription:
      "Beer back label with medium-weight prefix — borderline bold; flagged for human review.",
    imageUrl: "/samples/review.png",
    expectedVerdict: "review",
    expectedNote:
      "The Government Warning prefix is rendered at font-weight 500 (medium), not full bold (700). The validator flags this borderline case for human review rather than guessing.",
    declared: {
      brand_name: "Rust & Ember",
      class_type: "Lager",
      class_category: "beer",
      abv_percent: 6.7,
      net_contents: { value: 25, unit: "fl_oz" },
      producer: {
        name: "Rust Ember Beverage Co.",
        street: "945 Main St",
        city: "Walla Walla",
        state: "WA",
        postal_code: "99362",
        country: "USA",
      },
      country_of_origin: "USA",
    },
  },
];

export function getSample(id: Sample["id"]): Sample {
  const s = SAMPLES.find((x) => x.id === id);
  if (!s) throw new Error(`Unknown sample id: ${id}`);
  return s;
}
