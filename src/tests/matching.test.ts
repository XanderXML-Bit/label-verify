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
