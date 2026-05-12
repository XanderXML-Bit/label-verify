import { describe, it, expect } from "vitest";
import { compareProducer } from "@/lib/matching";
import type { ProducerAddress } from "@/lib/vision/types";

// ─── Producer-country inference regression test ───────────────────────────
//
// The previous comparator counted `extracted.country = null` as a hard
// mismatch even when the producer's state was a US state. Most real
// TTB labels DO NOT explicitly print "Country of origin: USA" — they
// rely on the state to imply it (e.g. "Portland, ME 04101"). The fix
// recognises this pattern. These tests pin the new behaviour.

const declaredUsa: ProducerAddress = {
  name: "Mill Creek Beverage Co.",
  street: "100 Brewery Way",
  city: "Asheville",
  state: "NC",
  postal_code: "28801",
  country: "USA",
};

describe("compareProducer — implicit-USA inference", () => {
  it("PASSes when extracted country is null but state is a US state code", () => {
    const extracted: ProducerAddress = {
      ...declaredUsa,
      country: null,
    };
    const r = compareProducer(declaredUsa, extracted, 0.9);
    expect(r.status).toBe("pass");
    expect(r.components?.country).toBe("pass");
  });

  it("PASSes when extracted state is 'NC' (case insensitive)", () => {
    const extracted: ProducerAddress = {
      ...declaredUsa,
      state: "nc",
      country: null,
    };
    const r = compareProducer(declaredUsa, extracted, 0.9);
    expect(r.status).toBe("pass");
  });

  it("PASSes when declared country is 'United States' variant", () => {
    const declared = { ...declaredUsa, country: "United States" };
    const extracted: ProducerAddress = {
      ...declaredUsa,
      country: null,
    };
    const r = compareProducer(declared, extracted, 0.9);
    expect(r.status).toBe("pass");
  });

  it("FAILs when declared is USA but extracted state is NOT a US state and country is null", () => {
    const extracted: ProducerAddress = {
      ...declaredUsa,
      city: "Toronto",
      state: "ON",
      country: null,
    };
    const r = compareProducer(declaredUsa, extracted, 0.9);
    // State + city also mismatch, so overall is fail; but specifically
    // country.status should still be "fail" because ON isn't a US state.
    expect(r.components?.country).toBe("fail");
  });

  it("FAILs when declared USA but extracted country is explicitly Mexico", () => {
    const extracted: ProducerAddress = {
      ...declaredUsa,
      country: "Mexico",
    };
    const r = compareProducer(declaredUsa, extracted, 0.9);
    expect(r.components?.country).toBe("fail");
  });

  it("PASSes when extracted country IS 'USA' explicitly (no inference needed)", () => {
    const extracted: ProducerAddress = {
      ...declaredUsa,
    };
    const r = compareProducer(declaredUsa, extracted, 0.9);
    expect(r.status).toBe("pass");
    expect(r.components?.country).toBe("pass");
  });

  it("Does NOT apply implicit-USA when declared country is non-USA", () => {
    const declared = { ...declaredUsa, country: "Mexico" };
    const extracted: ProducerAddress = {
      ...declaredUsa,
      state: "CA",  // a US state
      country: null,
    };
    const r = compareProducer(declared, extracted, 0.9);
    // Declared Mexico but extracted state is California → cannot infer
    // Mexico from California state.
    expect(r.components?.country).toBe("fail");
  });

  it("Covers DC and PR (often-forgotten US territories)", () => {
    for (const state of ["DC", "PR"]) {
      const extracted: ProducerAddress = {
        ...declaredUsa,
        state,
        country: null,
      };
      const r = compareProducer(declaredUsa, extracted, 0.9);
      expect(r.components?.country, `state=${state}`).toBe("pass");
    }
  });

  it("Still flags 1-component mismatch (city) as REVIEW, not FAIL", () => {
    const extracted: ProducerAddress = {
      ...declaredUsa,
      city: "Greensboro", // wrong city, everything else right
      country: null,
    };
    const r = compareProducer(declaredUsa, extracted, 0.9);
    // 1 fail (city) → "review"
    expect(r.status).toBe("review");
  });
});
