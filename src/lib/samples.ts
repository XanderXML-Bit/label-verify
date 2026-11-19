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
    shortDescription: "Beer label that matches the application and passes the warning checks.",
    imageUrl: "/samples/pass.jpg",
    expectedVerdict: "pass",
    expectedNote:
      "The label matches the declared fields. The Government Warning passes this tool's checks for 27 CFR §16.21 and §16.22.",
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
    // "Title-case warning prefix defect confirmed." The label prints
    // "Produced by Mercers Reserve Beverage Co., Denver, CO" (no
    // apostrophe), so the application declares that same producer and
    // the warning prefix is the only failing check.
    id: "fail",
    label: "FAIL sample",
    shortDescription:
      "The spirits label fails the check for an all-caps Government Warning prefix.",
    imageUrl: "/samples/fail.jpg",
    expectedVerdict: "fail",
    expectedNote:
      "The prefix reads 'Government Warning:' in title case. It fails this tool's capitalization check for 27 CFR §16.22(a)(2).",
    declared: {
      brand_name: "Mercer's Reserve",
      class_type: "Vodka",
      class_category: "distilled_spirits",
      abv_percent: 40.0,
      net_contents: { value: 750, unit: "ml" },
      producer: {
        name: "Mercers Reserve Beverage Co.",
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
    // "Pilsner", application declares "Lager". The comparator treats
    // them as distinct class designations and routes the pair to REVIEW. This
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
      "The label says 'Pilsner' and the application says 'Lager'. The tool flags the difference for review.",
    imageUrl: "/samples/pass.jpg",
    expectedVerdict: "review",
    expectedNote:
      "The label prints 'Pilsner' and the application declares 'Lager'. This tool treats them as distinct class designations and asks you to confirm the match.",
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
