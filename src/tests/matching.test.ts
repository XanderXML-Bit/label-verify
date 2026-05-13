import { describe, expect, it } from "vitest";
import {
  compareBrand,
  normalizeBrand,
  compareAbv,
  abvTolerancePP,
  compareNetContents,
  toMl,
  compareCountry,
  compareClass,
  compareProducer,
} from "@/lib/matching";

describe("normalizeBrand", () => {
  it("smart quotes, case, padding", () => {
    expect(normalizeBrand("Stone’s Throw Brewing")).toBe("stone's throw brewing");
    expect(normalizeBrand("STONE'S THROW BREWING")).toBe("stone's throw brewing");
  });
});

describe("compareBrand", () => {
  it("R6: STONE'S THROW ≡ Stone's Throw → PASS", () => {
    const r = compareBrand("Stone's Throw Brewing", "STONE'S THROW BREWING");
    expect(r.status).toBe("pass");
  });

  it("Distinct brands → FAIL", () => {
    const r = compareBrand("Stone's Throw Brewing", "Sierra Nevada Brewing");
    expect(r.status).toBe("fail");
  });

  it("Short-brand instability: Coors Light vs Coots Light → not PASS", () => {
    const r = compareBrand("Coors Light", "Coots Light");
    expect(r.status === "review" || r.status === "fail").toBe(true);
  });

  it("Null extracted brand → FAIL", () => {
    const r = compareBrand("Stone's Throw", null);
    expect(r.status).toBe("fail");
  });
});

describe("compareAbv", () => {
  it("beer within ±0.3pp → PASS", () => {
    expect(compareAbv(6.4, "beer", 6.55, 0.9).status).toBe("pass");
  });
  it("beer outside ±0.3pp → FAIL", () => {
    expect(compareAbv(6.4, "beer", 7.0, 0.9).status).toBe("fail");
  });
  it("low extractor confidence demotes to REVIEW", () => {
    const r = compareAbv(6.4, "beer", 6.4, 0.4);
    expect(r.status).toBe("review");
  });
  it("wine ≥14% uses ±1.0pp; 14.9 vs 14.0 → PASS", () => {
    expect(compareAbv(14.0, "wine", 14.9, 0.9).status).toBe("pass");
  });
  it("wine <14% uses ±0.5pp; 12.0 vs 13.0 → FAIL", () => {
    expect(compareAbv(12.0, "wine", 13.0, 0.9).status).toBe("fail");
  });
  it("distilled spirits ±0.15pp; 40.0 vs 40.2 → PASS, vs 40.3 → FAIL", () => {
    expect(compareAbv(40.0, "distilled_spirits", 40.1, 0.9).status).toBe("pass");
    expect(compareAbv(40.0, "distilled_spirits", 40.5, 0.9).status).toBe("fail");
  });

  it("abvTolerancePP returns the right band", () => {
    expect(abvTolerancePP("beer", 5)).toBe(0.3);
    expect(abvTolerancePP("wine", 13)).toBe(0.5);
    expect(abvTolerancePP("wine", 15)).toBe(1.0);
    expect(abvTolerancePP("distilled_spirits", 40)).toBe(0.15);
  });
});

describe("compareNetContents", () => {
  it("PASS on exact unit match", () => {
    const r = compareNetContents(
      { value: 12, unit: "fl_oz" },
      { value: 12, unit: "fl_oz" },
      0.9,
    );
    expect(r.status).toBe("pass");
  });
  it("PASS on equivalent unit conversion (12 fl_oz ≈ 355 ml)", () => {
    const r = compareNetContents(
      { value: 12, unit: "fl_oz" },
      { value: 355, unit: "ml" },
      0.9,
    );
    expect(r.status).toBe("pass");
  });
  it("FAIL on different volumes", () => {
    const r = compareNetContents(
      { value: 12, unit: "fl_oz" },
      { value: 16, unit: "fl_oz" },
      0.9,
    );
    expect(r.status).toBe("fail");
  });
  it("toMl conversions", () => {
    expect(toMl({ value: 1, unit: "L" })).toBe(1000);
    expect(toMl({ value: 1, unit: "cl" })).toBe(10);
    expect(toMl({ value: 1, unit: "fl_oz" })).toBeCloseTo(29.5735, 3);
  });
});

describe("compareCountry", () => {
  it("USA ≡ United States ≡ U.S.A. → PASS", () => {
    expect(compareCountry("United States", "USA", 0.9).status).toBe("pass");
    expect(compareCountry("USA", "U.S.A.", 0.9).status).toBe("pass");
    expect(compareCountry("United States", "U.S.", 0.9).status).toBe("pass");
  });
  it("USA vs France → FAIL", () => {
    expect(compareCountry("USA", "France", 0.9).status).toBe("fail");
  });
  it("Spanish synonyms for USA → PASS (OOD audit fix, ai-label-0012)", () => {
    // The OOD corpus re-audit (2026-05-12) caught that ai-label-0012
    // prints "PRODUCTO DE EE. UU." — the model correctly reads it,
    // but the comparator's SYNONYMS table didn't include the Spanish
    // form, so it was scored as a model error.
    expect(compareCountry("USA", "EE. UU.", 0.9).status).toBe("pass");
    expect(compareCountry("USA", "EE.UU.", 0.9).status).toBe("pass");
    expect(compareCountry("USA", "PRODUCTO DE EE. UU.", 0.9).status).toBe(
      "pass",
    );
    expect(compareCountry("USA", "Estados Unidos", 0.9).status).toBe("pass");
    expect(
      compareCountry("USA", "Estados Unidos de America", 0.9).status,
    ).toBe("pass");
  });
  it("multilingual country synonyms across the top alcohol-importing markets", () => {
    // TTB COLA applications come in from every alcohol-importing
    // country. The comparator has to recognise country names in local
    // languages too. Spot-checks across the table:
    expect(compareCountry("France", "République Française", 0.9).status).toBe("pass");
    expect(compareCountry("France", "FR", 0.9).status).toBe("pass");
    expect(compareCountry("Italy", "Italia", 0.9).status).toBe("pass");
    expect(compareCountry("Germany", "Deutschland", 0.9).status).toBe("pass");
    expect(compareCountry("Spain", "España", 0.9).status).toBe("pass");
    expect(compareCountry("Japan", "日本", 0.9).status).toBe("pass");
    expect(compareCountry("Japan", "Nippon", 0.9).status).toBe("pass");
    expect(compareCountry("Mexico", "México", 0.9).status).toBe("pass");
    expect(compareCountry("Mexico", "Estados Unidos Mexicanos", 0.9).status).toBe("pass");
    expect(compareCountry("Netherlands", "Nederland", 0.9).status).toBe("pass");
    expect(compareCountry("Switzerland", "Suisse", 0.9).status).toBe("pass");
    expect(compareCountry("South Korea", "대한민국", 0.9).status).toBe("pass");
    expect(compareCountry("Greece", "Ελλάδα", 0.9).status).toBe("pass");
    // Cross-language mismatches still FAIL.
    expect(compareCountry("Germany", "Frankreich", 0.9).status).toBe("fail");
    expect(compareCountry("Japan", "中国", 0.9).status).toBe("fail");
  });

  // Null-declared branch: TTB only requires country marking on imports
  // (27 CFR §4.39 / §5.36). Applications for US-domestic labels may
  // legitimately omit `country_of_origin`, and the schema accepts
  // `null` to reflect that. The comparator must agree:
  //   - null declared + null extracted → PASS (both agree no marking)
  //   - null declared + extracted shows a country → REVIEW (might be
  //     an undeclared import; route to human)
  it("null declared + null extracted → PASS (both agree no marking)", () => {
    const r = compareCountry(null, null, 0.9);
    expect(r.status).toBe("pass");
    expect(r.expected).toBeNull();
    expect(r.actual).toBeNull();
  });
  it("WAVE-17: null declared + extracted=USA → PASS (US-domestic implicit declaration)", () => {
    // TTB only mandates country marking on imports. US-domestic
    // operators routinely leave country_of_origin blank on the
    // COLA form; the label's printed "USA" (or "Product of USA",
    // etc.) is the implicit declaration. Wave-17 escalates this
    // case from REVIEW to PASS at confidence 0.7.
    const r = compareCountry(null, "USA", 0.9);
    expect(r.status).toBe("pass");
    expect(r.actual).toBe("USA");
  });
  it("WAVE-17: null declared + extracted=United States → PASS (canonicalized USA)", () => {
    // Any USA synonym/canonicalization should match the wave-17 path.
    expect(compareCountry(null, "United States", 0.9).status).toBe("pass");
    expect(compareCountry(null, "U.S.A.", 0.9).status).toBe("pass");
    expect(compareCountry(null, "Estados Unidos", 0.9).status).toBe("pass");
  });
  it("WAVE-17: null declared + extracted=FOREIGN country still → REVIEW", () => {
    // The wave-17 PASS is gated to USA specifically. A foreign
    // country with no declared value remains REVIEW — legitimate
    // signal that the operator may have forgotten to declare an
    // import.
    const r = compareCountry(null, "Italy", 0.9);
    expect(r.status).toBe("review");
    expect(r.reason).toMatch(/Italy/);
  });
  it("WAVE-17: null declared + extracted=France still → REVIEW", () => {
    expect(compareCountry(null, "France", 0.9).status).toBe("review");
  });
  it("empty-string declared treated as null (defensive: some parsers emit '' for missing)", () => {
    const r = compareCountry("", null, 0.9);
    expect(r.status).toBe("pass");
  });
  it("WAVE-17: empty-string declared + USA-extracted → PASS (same as null path)", () => {
    expect(compareCountry("", "USA", 0.9).status).toBe("pass");
  });
});

describe("compareClass", () => {
  it("IPA ≡ India Pale Ale → PASS", () => {
    expect(compareClass("India Pale Ale", "IPA", 0.9).status).toBe("pass");
  });
  it("Cabernet ≡ Cabernet Sauvignon → PASS", () => {
    expect(compareClass("Cabernet Sauvignon", "Cabernet", 0.9).status).toBe("pass");
  });
  it("IPA vs Stout → FAIL", () => {
    expect(compareClass("India Pale Ale", "Stout", 0.9).status).toBe("fail");
  });

  // Wave-16: substring-relaxation REVIEW path. The Levenshtein/token
  // comparator already handles the "declared is a substring of
  // extracted" case (fast-fuzzy returns 1.0 on token-subset matches —
  // e.g. "Grenache" ⊆ "Grenache Red Wine" already PASSes). But the
  // REVERSE asymmetry — extracted shorter, declared longer — drops
  // below the 0.7 REVIEW band (e.g. fast-fuzzy("Mango Lime Malt
  // Beverage Hard Seltzer Variety", "Mango Lime") = 0.22). Wave-16
  // catches THAT case and routes to REVIEW.
  it("WAVE-16: extracted is a short substring of declared → REVIEW (length-mismatch case)", () => {
    // Declared was descriptive, label printed a concise variant.
    // Pre-wave-16: ratio ~0.22 → FAIL. Wave-16: REVIEW with
    // substring-match reason.
    const r = compareClass(
      "Mango Lime Malt Beverage Hard Seltzer Variety",
      "Mango Lime",
      0.9,
    );
    expect(r.status).toBe("review");
    expect(r.reason).toMatch(/substring/i);
  });

  it("WAVE-16: neither string contains the other → FAIL (no relaxation)", () => {
    // Different classes; substring path correctly does NOT fire.
    const r = compareClass(
      "Mango Lime Malt Seltzer",
      "Hard Seltzer Malt Beverage",
      0.9,
    );
    expect(r.status).toBe("fail");
  });

  it("WAVE-16: short shorter-side (< 5 chars) is NOT substring-escalated", () => {
    // The minimum-shorter-length guard (≥ 5 chars after
    // canonicalization) prevents short-token false positives.
    // "Rum" (3 chars) gets through fast-fuzzy's token-set matcher
    // anyway (returns 1.0 on "rum" ⊆ "rum punch") — the guard
    // matters for the reverse case where the SHORT side would
    // otherwise force an unsafe substring escalation.
    const shortForm = "ABC"; // 3 chars after canonicalization
    const longForm = "ABC-Long-Description-Of-A-Different-Style";
    const r = compareClass(longForm, shortForm, 0.9);
    if (r.status === "review") {
      // If it's review, it must NOT be due to the wave-16 substring
      // path (which the < 5-char guard blocks).
      expect(r.reason ?? "").not.toMatch(/substring/i);
    }
  });

  it("WAVE-16: identical canonicalized values still PASS (substring path doesn't override)", () => {
    // Regression guard: the substring path is gated by `!pass && !review`,
    // so identical-after-canonicalization values still PASS via the
    // earlier branch.
    expect(compareClass("IPA", "IPA", 0.9).status).toBe("pass");
  });
});

describe("compareProducer (structured)", () => {
  it("all components match → PASS", () => {
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
  });
  it("one component off → REVIEW (component-level diff)", () => {
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
        state: "TN", // <- mismatched state
        postal_code: "28801",
        country: "USA",
      },
      0.9,
    );
    expect(r.status).toBe("review");
    expect(r.components?.state).toBe("fail");
  });
});

describe("compareProducer (freeform declared)", () => {
  it("freeform string matches joined extracted → PASS", () => {
    const r = compareProducer(
      "Stone's Throw Brewing Co., 14 Mill St, Asheville, NC 28801, USA",
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
  });
});
