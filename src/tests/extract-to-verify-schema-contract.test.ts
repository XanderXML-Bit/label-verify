// Wave-35m — extract → verify schema contract.
//
// The "Continue to verification" affordance on the ExtractionOnly
// result panel hands the extractor's output back into the verify
// flow with the form pre-filled. The transformation lives in
// `continueToVerification()` in `src/app/page.tsx`:
//
//     const fields: Partial<DeclaredFields> = {
//       brand_name: typeof e.brand_name.value === "string" ? e.brand_name.value : undefined,
//       class_type: typeof e.class_type.value === "string" ? e.class_type.value : undefined,
//       abv_percent: typeof e.abv_percent.value === "number" ? e.abv_percent.value : undefined,
//       net_contents:
//         e.net_contents.value && typeof e.net_contents.value === "object"
//           ? e.net_contents.value
//           : undefined,
//       producer:
//         typeof e.producer.value === "string" || (e.producer.value && typeof e.producer.value === "object")
//           ? (e.producer.value as DeclaredFields["producer"])
//           : undefined,
//       country_of_origin:
//         typeof e.country_of_origin.value === "string"
//           ? e.country_of_origin.value
//           : undefined,
//     };
//
// The risk: if the extractor's response shape narrows OR the
// verify-side `DeclaredFieldsSchema` tightens, this handoff can
// silently break — the form's prefill drops the affected field and
// the user has to re-type something the model already saw on the
// label.
//
// This file pins the contract end-to-end:
//   1. Build a representative `ExtractedFields` (matches the API
//      response from /api/extract).
//   2. Apply the *same* field-by-field mapping that
//      `continueToVerification` does in page.tsx.
//   3. Add the one piece the extractor doesn't provide
//      (`class_category`) which is genuinely a user choice.
//   4. Assert `DeclaredFieldsSchema.safeParse(...)` succeeds.
//
// The test would fail if `DeclaredFieldsSchema` ever gained a new
// required field that the extractor doesn't return, OR if the
// extractor's value-types diverged from what the schema expects.

import { describe, expect, it } from "vitest";
import {
  DeclaredFieldsSchema,
  type DeclaredFields,
} from "@/lib/types";
import type { ExtractedFields } from "@/lib/vision/types";

// Helper mirroring `continueToVerification()` in page.tsx. Kept as a
// local copy rather than imported because page.tsx is a 1.5K-line
// "use client" React component and the mapping is 12 lines — pulling
// the whole module into a vitest run would force a jsdom + React
// boot for no useful coverage. If the production mapping ever
// changes, this test's copy must change too; the comment above
// flags that.
function extractedToPartialDeclared(
  e: ExtractedFields,
): Partial<DeclaredFields> {
  return {
    brand_name:
      typeof e.brand_name.value === "string" ? e.brand_name.value : undefined,
    class_type:
      typeof e.class_type.value === "string" ? e.class_type.value : undefined,
    abv_percent:
      typeof e.abv_percent.value === "number" ? e.abv_percent.value : undefined,
    net_contents:
      e.net_contents.value && typeof e.net_contents.value === "object"
        ? e.net_contents.value
        : undefined,
    producer:
      typeof e.producer.value === "string" ||
      (e.producer.value && typeof e.producer.value === "object")
        ? (e.producer.value as DeclaredFields["producer"])
        : undefined,
    country_of_origin:
      typeof e.country_of_origin.value === "string"
        ? e.country_of_origin.value
        : undefined,
  };
}

function representativeExtractedFields(): ExtractedFields {
  return {
    brand_name: { value: "Mill Creek", confidence: 0.95 },
    class_type: { value: "Pilsner", confidence: 0.92 },
    abv_percent: { value: 5.2, confidence: 0.95 },
    net_contents: {
      value: { value: 12, unit: "fl_oz" },
      confidence: 0.9,
    },
    government_warning: {
      value: {
        raw_text:
          "GOVERNMENT WARNING: (1) According to the Surgeon General, women should not drink alcoholic beverages during pregnancy because of the risk of birth defects. (2) Consumption of alcoholic beverages impairs your ability to drive a car or operate machinery, and may cause health problems.",
        prefix_text: "GOVERNMENT WARNING",
        prefix_bbox: { x: 100, y: 200, width: 400, height: 20 },
        prefix_appears_bold: true,
        prefix_appears_caps: true,
      },
      confidence: 0.9,
    },
    producer: {
      value: {
        name: "Mill Creek Beverage Co.",
        street: null,
        city: "Asheville",
        state: "NC",
        postal_code: null,
        country: "USA",
      },
      confidence: 0.85,
    },
    country_of_origin: { value: "USA", confidence: 0.95 },
  };
}

describe("extract → verify schema contract (continueToVerification handoff)", () => {
  it("a clean extractor response, mapped via the page.tsx transformation, satisfies DeclaredFieldsSchema once class_category is filled", async () => {
    const extracted = representativeExtractedFields();
    const partial = extractedToPartialDeclared(extracted);
    // `class_category` is the one field the extractor cannot
    // provide (it's a TTB taxonomy choice, not a label-readable
    // value). The DeclaredForm requires the user to select it
    // before "Verify" is enabled. Inject it here to mirror what
    // the user does on the form.
    const declared = { ...partial, class_category: "beer" as const };
    const parsed = DeclaredFieldsSchema.safeParse(declared);
    expect(parsed.success).toBe(true);
    if (parsed.success) {
      expect(parsed.data.brand_name).toBe("Mill Creek");
      expect(parsed.data.class_type).toBe("Pilsner");
      expect(parsed.data.abv_percent).toBe(5.2);
      expect(parsed.data.net_contents).toEqual({ value: 12, unit: "fl_oz" });
      expect(parsed.data.country_of_origin).toBe("USA");
    }
  });

  it("missing class_category fails validation (form-side guard, not extractor-side)", async () => {
    // Document the asymmetry: every other field flows from the
    // extractor's read of the label; class_category does not. If
    // we ever extended the prompt to also extract a beverage
    // category, this assertion would flip — that's intentional.
    const extracted = representativeExtractedFields();
    const partial = extractedToPartialDeclared(extracted);
    const parsed = DeclaredFieldsSchema.safeParse(partial);
    expect(parsed.success).toBe(false);
    if (!parsed.success) {
      // The single failing field should be class_category — every
      // other field should be present and well-typed in the partial.
      const missingPaths = parsed.error.issues.map((i) =>
        i.path.join("."),
      );
      expect(missingPaths).toContain("class_category");
    }
  });

  it("a null-producer extractor response (TTB-domestic case) still validates after class_category fill", async () => {
    // The extractor may legitimately return producer.value = null
    // for a label where the producer string is missing or
    // illegible. DeclaredFieldsSchema accepts null/undefined on
    // `producer` (wave-34 audit fix #13 — see lib/types.ts:40).
    const extracted = representativeExtractedFields();
    extracted.producer = { value: null, confidence: 0.2 };
    extracted.country_of_origin = { value: null, confidence: 0.2 };
    const partial = extractedToPartialDeclared(extracted);
    const declared = { ...partial, class_category: "beer" as const };
    const parsed = DeclaredFieldsSchema.safeParse(declared);
    expect(parsed.success).toBe(true);
    if (parsed.success) {
      // Producer is omitted (undefined → schema's nullish accepts).
      expect(parsed.data.producer).toBeUndefined();
      expect(parsed.data.country_of_origin).toBeUndefined();
    }
  });

  it("extractor returning string-only producer (legacy single-line) still validates", async () => {
    // Some bench fixtures + the older AI-generated corpus emit
    // producer as a freeform string instead of the structured
    // ProducerAddress object. The schema's union accepts either.
    // Important to confirm because the page.tsx mapping does a
    // typeof-check + structural cast that would silently coerce
    // wrongly if the schema's union tightened.
    const extracted = representativeExtractedFields();
    extracted.producer = {
      value: "Mill Creek Beverage Co., Asheville, NC, USA" as unknown as ExtractedFields["producer"]["value"],
      confidence: 0.85,
    };
    const partial = extractedToPartialDeclared(extracted);
    const declared = { ...partial, class_category: "beer" as const };
    const parsed = DeclaredFieldsSchema.safeParse(declared);
    expect(parsed.success).toBe(true);
    if (parsed.success) {
      expect(typeof parsed.data.producer).toBe("string");
      expect(parsed.data.producer).toMatch(/Mill Creek/);
    }
  });

  it("missing net_contents (extractor couldn't read) drops the field rather than corrupting it", async () => {
    // Defensive: if the extractor returns net_contents.value=null
    // (label has no readable size), the mapping must leave the
    // partial's net_contents undefined — NOT pass a malformed
    // object through. Without this guard a downstream
    // `parsed.net_contents.value` access would throw on null.
    const extracted = representativeExtractedFields();
    extracted.net_contents = { value: null, confidence: 0.1 };
    const partial = extractedToPartialDeclared(extracted);
    expect(partial.net_contents).toBeUndefined();
    // With net_contents required on DeclaredFieldsSchema, this
    // case necessarily fails until the user types it on the form
    // — that's the intended behaviour, the form blocks submit.
    const declared = { ...partial, class_category: "beer" as const };
    const parsed = DeclaredFieldsSchema.safeParse(declared);
    expect(parsed.success).toBe(false);
    if (!parsed.success) {
      expect(parsed.error.issues.map((i) => i.path.join("."))).toContain(
        "net_contents",
      );
    }
  });
});
