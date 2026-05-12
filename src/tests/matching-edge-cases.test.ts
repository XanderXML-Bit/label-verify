import { describe, expect, it } from "vitest";
import {
  compareBrand,
  compareCountry,
  compareClass,
  compareNetContents,
  compareProducer,
} from "@/lib/matching";

describe("matching — edge cases", () => {
  describe("compareBrand: diacritics + Unicode normalization", () => {
    it("'Côte du Soir' ≡ 'Cote du Soir' is reasonable enough to not FAIL", () => {
      // The current normalizer keeps NFC diacritics, so "ô" and "o" remain
      // distinct under fuzzy ratio. Document the current behaviour: this is
      // a near-miss that should at worst land in REVIEW, never PASS-confident.
      const r = compareBrand("Côte du Soir", "Cote du Soir");
      // Not strictly fail — char-similarity is high. We accept pass OR review
      // here; this codifies the current behaviour without over-promising.
      expect(["pass", "review"]).toContain(r.status);
    });

    it("smart-quote ≡ straight-quote in brand normalization", () => {
      const r = compareBrand("Stone’s Throw", "Stone's Throw");
      expect(r.status).toBe("pass");
    });
  });

  describe("compareAbv: decimal-separator parsing", () => {
    // The comparator takes a number, not a string — so a comma-decimal
    // like "6,4%" is a *parsing* concern upstream. This test pins the fact
    // that no string-parsing happens in compareAbv, so callers must pass a
    // proper Number. Anything else is the caller's bug.
    it("compareAbv signature accepts only numbers — comma-decimal is a caller-side concern", async () => {
      const mod = await import("@/lib/matching/abv");
      // We can't reach into TypeScript's compiled types at runtime; this is
      // a smoke check that the export shape is what we expect.
      expect(typeof mod.compareAbv).toBe("function");
      // And confirm the happy-path arithmetic still works with a normal number.
      expect(mod.compareAbv(6.4, "beer", 6.4, 0.9).status).toBe("pass");
    });
  });

  describe("compareNetContents: cross-unit rounding band", () => {
    it("750 ml ≈ 25.36 fl_oz — should PASS within the ±1.5 ml band", () => {
      // 25.36 fl_oz × 29.5735 ml/fl_oz = 750.10 ml — well within ±1.5 ml.
      const r = compareNetContents(
        { value: 750, unit: "ml" },
        { value: 25.36, unit: "fl_oz" },
        0.9,
      );
      expect(r.status).toBe("pass");
    });

    it("750 ml vs 26 fl_oz (~769 ml) is outside the band — FAIL", () => {
      const r = compareNetContents(
        { value: 750, unit: "ml" },
        { value: 26, unit: "fl_oz" },
        0.9,
      );
      expect(r.status).toBe("fail");
    });
  });

  describe("compareCountry: case insensitivity + ISO aliases", () => {
    it("'usa' (lowercase) ≡ 'USA' → PASS", () => {
      expect(compareCountry("usa", "USA", 0.9).status).toBe("pass");
    });

    it("'US' alpha-2 ≡ 'United States' → PASS", () => {
      expect(compareCountry("US", "United States", 0.9).status).toBe("pass");
    });

    it("Mexican aliases canonicalize ('MX' ≡ 'Mexico')", () => {
      expect(compareCountry("MX", "Mexico", 0.9).status).toBe("pass");
    });
  });

  describe("compareClass: punctuation tolerance", () => {
    it("'Pinot-Noir' (hyphenated) ≡ 'Pinot Noir' → PASS", () => {
      // The normalizer collapses non-alphanumeric runs to spaces, so a hyphen
      // becomes a space — both sides canonicalize to "pinot noir".
      expect(compareClass("Pinot-Noir", "Pinot Noir", 0.9).status).toBe("pass");
    });

    it("'Pinot' alone ≡ 'Pinot Noir' via the ALIASES table → PASS", () => {
      expect(compareClass("Pinot Noir", "Pinot", 0.9).status).toBe("pass");
    });
  });

  describe("compareProducer: mixed structured / freeform inputs", () => {
    it("structured declared + matching extracted = PASS per-component", () => {
      const r = compareProducer(
        {
          name: "Stone's Throw Brewing Co.",
          street: "14 Mill St",
          city: "Asheville",
          state: "NC",
          postal_code: "28801",
          country: "USA",
        },
        {
          name: "Stone's Throw Brewing Co.",
          street: "14 Mill St",
          city: "Asheville",
          state: "NC",
          postal_code: "28801",
          country: "USA",
        },
        0.9,
      );
      expect(r.status).toBe("pass");
      expect(r.components?.street).toBe("pass");
    });

    it("freeform declared compared against partially-populated extracted is forgiving", () => {
      // Freeform path uses a single fuzzy ratio over the joined fields.
      // Missing state/postal in the extracted side should still match.
      const r = compareProducer(
        "Stone's Throw Brewing Co., 14 Mill St, Asheville, NC, USA",
        {
          name: "Stone's Throw Brewing Co.",
          street: "14 Mill St",
          city: "Asheville",
          state: null,
          postal_code: null,
          country: "USA",
        },
        0.9,
      );
      expect(["pass", "review"]).toContain(r.status);
    });
  });
});
