import { describe, expect, it } from "vitest";
import {
  wilson95,
  summarize,
  mcNemar,
  stratify,
  falseNegativeRate,
  partitionOod,
  type PerItemOutcome,
  type PerItemWarningOutcome,
} from "../../benchmarks/score";

describe("wilson95", () => {
  it("handles n=0 gracefully", () => {
    const [lo, hi] = wilson95(0, 0);
    expect(lo).toBe(0);
    expect(hi).toBe(1);
  });
  it("90/100 → CI roughly [0.82, 0.94]", () => {
    const [lo, hi] = wilson95(90, 100);
    expect(lo).toBeGreaterThan(0.8);
    expect(hi).toBeLessThan(0.95);
  });
  it("CI always inside [0,1]", () => {
    const [lo, hi] = wilson95(100, 100);
    expect(lo).toBeGreaterThanOrEqual(0);
    expect(hi).toBeLessThanOrEqual(1);
  });
});

describe("summarize", () => {
  it("returns CI and n", () => {
    const outcomes = Array.from({ length: 10 }, (_, i) => ({
      imageId: `id-${i}`,
      field: "x",
      correct: i < 8,
      strata: {},
    }));
    const r = summarize(outcomes);
    expect(r.n).toBe(10);
    expect(r.acc).toBe(0.8);
    expect(r.ciLo).toBeLessThanOrEqual(0.8);
    expect(r.ciHi).toBeGreaterThanOrEqual(0.8);
  });
});

describe("mcNemar", () => {
  it("no discordants → p=1", () => {
    const both = [
      { imageId: "1", field: "x", correct: true, strata: {} },
      { imageId: "2", field: "x", correct: false, strata: {} },
    ];
    const r = mcNemar(both, both);
    expect(r.pValue).toBe(1);
  });

  it("A always right, B always wrong (strong disagreement) → low p", () => {
    const a = [
      { imageId: "1", field: "x", correct: true, strata: {} },
      { imageId: "2", field: "x", correct: true, strata: {} },
      { imageId: "3", field: "x", correct: true, strata: {} },
      { imageId: "4", field: "x", correct: true, strata: {} },
      { imageId: "5", field: "x", correct: true, strata: {} },
      { imageId: "6", field: "x", correct: true, strata: {} },
      { imageId: "7", field: "x", correct: true, strata: {} },
      { imageId: "8", field: "x", correct: true, strata: {} },
      { imageId: "9", field: "x", correct: true, strata: {} },
      { imageId: "10", field: "x", correct: true, strata: {} },
    ];
    const b = a.map((o) => ({ ...o, correct: false }));
    const r = mcNemar(a, b);
    expect(r.pValue).toBeLessThan(0.01);
  });
});

describe("stratify", () => {
  const data: PerItemOutcome[] = [
    { imageId: "1", field: "abv", correct: true, strata: { beverage: "beer" } },
    { imageId: "2", field: "abv", correct: true, strata: { beverage: "beer" } },
    { imageId: "3", field: "abv", correct: false, strata: { beverage: "wine" } },
  ];

  it("groups by beverage × field", () => {
    const rows = stratify(data, ["beverage"]);
    const beerRow = rows.find((r) => r.strata.beverage === "beer");
    const wineRow = rows.find((r) => r.strata.beverage === "wine");
    expect(beerRow?.acc.n).toBe(2);
    expect(beerRow?.acc.acc).toBe(1);
    expect(wineRow?.acc.n).toBe(1);
    expect(wineRow?.acc.acc).toBe(0);
  });
});

describe("falseNegativeRate", () => {
  it("counts only non-compliant items that escaped as PASS", () => {
    const w: PerItemWarningOutcome[] = [
      { imageId: "1", truthCompliant: false, predictedPass: true, strata: {} },
      { imageId: "2", truthCompliant: false, predictedPass: false, strata: {} },
      { imageId: "3", truthCompliant: false, predictedPass: false, strata: {} },
      { imageId: "4", truthCompliant: true, predictedPass: true, strata: {} },
    ];
    const r = falseNegativeRate(w);
    // 1 of 3 non-compliant got predicted PASS.
    expect(r.n).toBe(3);
    expect(r.acc).toBeCloseTo(1 / 3, 3);
  });
});

describe("partitionOod", () => {
  it("splits in-distribution from OOD", () => {
    const data: PerItemOutcome[] = [
      { imageId: "1", field: "x", correct: true, strata: {} },
      { imageId: "2", field: "x", correct: false, strata: {}, ood: true },
    ];
    const { id, ood } = partitionOod(data);
    expect(id.length).toBe(1);
    expect(ood.length).toBe(1);
  });
});
