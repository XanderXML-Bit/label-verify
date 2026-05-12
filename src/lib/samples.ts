// Pre-populated sample labels for the "Try a sample" affordance on the
// home page. Each sample bundles a static image URL (served from
// public/samples/) and the declared application data that should
// accompany it.
//
// As of 2026-05-12 these are sourced from the AI-generated photo
// corpus (test-data/ai-generated/labels/) — actual realistic photos
// of bottles + cans with mixed lighting, not the previous flat SVG
// renders. SVG renders are easier than real photos; a reviewer who
// only sees the demo's best case is misled. The AI photos give them
// a representative end-to-end result.

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
    // ai-label-0001 — Mill Creek Pilsner. Compliant photo-quality beer
    // label. Codex audit notes: "Compliant warning and primary fields
    // confirmed visually."
    id: "pass",
    label: "PASS sample",
    shortDescription: "Compliant beer label — every field should match.",
    imageUrl: "/samples/pass.jpg",
    expectedVerdict: "pass",
    expectedNote:
      "All seven regulated fields match the declared application data; Government Warning is fully compliant under 27 CFR §16.21.",
    declared: {
      brand_name: "Mill Creek",
      class_type: "Pilsner",
      class_category: "beer",
      abv_percent: 5.2,
      net_contents: { value: 12, unit: "fl_oz" },
      producer: {
        name: "Mill Creek Beverage Co.",
        street: null,
        city: "Asheville",
        state: "NC",
        postal_code: null,
        country: "USA",
      },
      country_of_origin: "USA",
    },
  },
  {
    // ai-label-0010 — Mercer's Reserve Vodka. Title-case "Government
    // Warning:" prefix instead of all-caps. Codex audit:
    // "Title-case warning prefix defect confirmed."
    id: "fail",
    label: "FAIL sample",
    shortDescription:
      "Spirits label with title-case 'Government Warning:' prefix — must fail (caps required).",
    imageUrl: "/samples/fail.jpg",
    expectedVerdict: "fail",
    expectedNote:
      "The Government Warning prefix is rendered in title case ('Government Warning:'). 27 CFR §16.21 requires all caps; this is a strict regulatory failure.",
    declared: {
      brand_name: "Mercer's Reserve",
      class_type: "Vodka",
      class_category: "distilled_spirits",
      abv_percent: 40.0,
      net_contents: { value: 750, unit: "ml" },
      producer: {
        name: "Mercer's Reserve Distilling",
        street: null,
        city: "Denver",
        state: "CO",
        postal_code: null,
        country: "USA",
      },
      country_of_origin: "USA",
    },
  },
  {
    // ai-label-0014 — Latitude Seven Hazy IPA. Partial occlusion on
    // producer/warning area. Codex audit: "Partial occlusion condition
    // confirmed; producer/address area not clean enough for strict
    // use." This is exactly the kind of imperfect-photo case the
    // pipeline should defer to human review on.
    id: "review",
    label: "REVIEW sample",
    shortDescription:
      "Hazy IPA can with partial occlusion over producer/warning — flagged for human review.",
    imageUrl: "/samples/review.jpg",
    expectedVerdict: "review",
    expectedNote:
      "A sticker or finger partially occludes the producer block and Government Warning. The pipeline cannot read the obscured fields confidently, so it routes the verdict to human review rather than guessing.",
    declared: {
      brand_name: "Latitude Seven",
      class_type: "Hazy IPA",
      class_category: "beer",
      abv_percent: 6.8,
      net_contents: { value: 16, unit: "fl_oz" },
      producer: {
        name: "Latitude Seven Brewing",
        street: null,
        city: "Seattle",
        state: "WA",
        postal_code: null,
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
