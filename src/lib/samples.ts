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
    // Reuses the PASS sample image (Mill Creek Pilsner). The
    // deferral is engineered by a class_type mismatch: label prints
    // "Pilsner", application declares "Lager". TTB treats those as
    // distinct class designations; the comparator's REVIEW_ALIASES
    // bucket (matching/class.ts) routes such pairs to REVIEW. This
    // is a real-production case — labels often use "Pilsner" and
    // "Lager" interchangeably even though they're not. Previous
    // sample (Latitude Seven IPA) used an image whose producer the
    // model reliably extracted as "Latitude Seven Beverage Co.,
    // Denver, CO" while declared said "Latitude Seven Brewing,
    // Seattle, WA" — that's a hard FAIL on producer, not REVIEW.
    // Pre-submission UI audit BLOCKER #1 (2026-05-12).
    id: "review",
    label: "REVIEW sample",
    shortDescription:
      "Label reads 'Pilsner', application declares 'Lager' — distinct TTB class designations, surfaced for human confirmation.",
    imageUrl: "/samples/pass.jpg",
    expectedVerdict: "review",
    expectedNote:
      "The label prints 'Pilsner' but the COLA application declares 'Lager'. These styles are used interchangeably on real labels but are distinct class designations under TTB rules — the comparator defers to a human reviewer rather than silently treating them as identical.",
    declared: {
      brand_name: "Mill Creek",
      class_type: "Lager",
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
];

export function getSample(id: Sample["id"]): Sample {
  const s = SAMPLES.find((x) => x.id === id);
  if (!s) throw new Error(`Unknown sample id: ${id}`);
  return s;
}
