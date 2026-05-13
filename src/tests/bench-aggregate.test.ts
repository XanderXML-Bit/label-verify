import { describe, expect, it } from "vitest";
import {
  aggregateRuns,
  perImageConsistency,
  type RunInput,
  type Bucket,
} from "@/lib/bench-aggregate";

// Helper: build a minimal run with N records of given buckets.
function makeRun(
  passRateOnCorrect: number,
  failOrReviewRateOnWrong: number,
  errors: number,
  p50_total: number,
  p95_total: number,
  records: Array<{ image: string; condition: "correct" | "wrong"; bucket: Bucket }>,
): RunInput {
  return {
    summary: {
      passRateOnCorrect,
      failOrReviewRateOnWrong,
      errors,
      latencyMs: {
        p50_total,
        p95_total,
        p50_vision: p50_total - 500,
        p95_vision: p95_total - 1000,
      },
    },
    records: records.map((r) => ({
      image: r.image,
      condition: r.condition,
      bucket: r.bucket,
    })),
  };
}

describe("aggregateRuns", () => {
  it("computes mean across N runs", () => {
    const runs = [
      makeRun(0.70, 1.0, 5, 3000, 7000, []),
      makeRun(0.80, 1.0, 5, 3200, 7100, []),
      makeRun(0.75, 1.0, 5, 3100, 7050, []),
    ];
    const agg = aggregateRuns(runs);
    // Mean of [0.70, 0.80, 0.75] = 0.75
    expect(agg.passRateOnCorrect.mean).toBeCloseTo(0.75, 4);
    expect(agg.failOrReviewRateOnWrong.mean).toBeCloseTo(1.0, 4);
    expect(agg.errors.mean).toBeCloseTo(5, 4);
    expect(agg.p50_total.mean).toBeCloseTo(3100, 0);
  });

  it("computes (sample) standard deviation across N runs", () => {
    const runs = [
      makeRun(0.70, 1.0, 5, 3000, 7000, []),
      makeRun(0.80, 1.0, 5, 3200, 7100, []),
      makeRun(0.75, 1.0, 5, 3100, 7050, []),
    ];
    const agg = aggregateRuns(runs);
    // Sample SD of [0.70, 0.80, 0.75] — variance is sum((x-mean)^2)/(N-1)
    // = ((0.05)^2 + (0.05)^2 + 0^2) / 2 = 0.00125. SD = sqrt = ~0.0354.
    expect(agg.passRateOnCorrect.sd).toBeCloseTo(0.05, 2);
    // Latency P50 spread of 200 across [3000, 3200, 3100]: sample SD = 100.
    expect(agg.p50_total.sd).toBeCloseTo(100, 0);
  });

  it("reports n + min + max for each metric", () => {
    const runs = [
      makeRun(0.60, 1.0, 5, 3000, 7000, []),
      makeRun(0.80, 1.0, 5, 3000, 7000, []),
    ];
    const agg = aggregateRuns(runs);
    expect(agg.passRateOnCorrect.n).toBe(2);
    expect(agg.passRateOnCorrect.min).toBeCloseTo(0.60);
    expect(agg.passRateOnCorrect.max).toBeCloseTo(0.80);
  });

  it("handles a single run (SD = 0)", () => {
    // SD of a single observation is undefined statistically, but for
    // operator-facing reporting we report 0 — the caller knows N=1.
    const runs = [makeRun(0.70, 1.0, 5, 3000, 7000, [])];
    const agg = aggregateRuns(runs);
    expect(agg.passRateOnCorrect.mean).toBeCloseTo(0.70);
    expect(agg.passRateOnCorrect.sd).toBe(0);
    expect(agg.passRateOnCorrect.n).toBe(1);
  });

  it("rejects an empty run list", () => {
    expect(() => aggregateRuns([])).toThrow(/at least one run/i);
  });
});

describe("perImageConsistency — deterministic-failure vs flipper detection", () => {
  it("flags an image as DETERMINISTIC_FAIL when it failed every run", () => {
    const runs = [
      makeRun(0.5, 1, 0, 3000, 7000, [
        { image: "a.jpg", condition: "correct", bucket: "false-fail" },
      ]),
      makeRun(0.5, 1, 0, 3000, 7000, [
        { image: "a.jpg", condition: "correct", bucket: "false-fail" },
      ]),
      makeRun(0.5, 1, 0, 3000, 7000, [
        { image: "a.jpg", condition: "correct", bucket: "false-fail" },
      ]),
    ];
    const out = perImageConsistency(runs);
    const row = out.find((r) => r.image === "a.jpg" && r.condition === "correct");
    expect(row).toBeDefined();
    expect(row?.classification).toBe("DETERMINISTIC_FAIL");
    expect(row?.timesObserved).toBe(3);
    expect(row?.bucketCounts["false-fail"]).toBe(3);
  });

  it("flags an image as FLIPPER when buckets differ across runs", () => {
    const runs = [
      makeRun(0.5, 1, 0, 3000, 7000, [
        { image: "flippy.jpg", condition: "correct", bucket: "true-pass" },
      ]),
      makeRun(0.5, 1, 0, 3000, 7000, [
        { image: "flippy.jpg", condition: "correct", bucket: "false-fail" },
      ]),
      makeRun(0.5, 1, 0, 3000, 7000, [
        { image: "flippy.jpg", condition: "correct", bucket: "review-on-correct" },
      ]),
    ];
    const out = perImageConsistency(runs);
    const row = out.find(
      (r) => r.image === "flippy.jpg" && r.condition === "correct",
    );
    expect(row?.classification).toBe("FLIPPER");
    expect(row?.bucketCounts["true-pass"]).toBe(1);
    expect(row?.bucketCounts["false-fail"]).toBe(1);
    expect(row?.bucketCounts["review-on-correct"]).toBe(1);
  });

  it("flags an image as DETERMINISTIC_PASS when it passed every run", () => {
    const runs = [
      makeRun(1, 1, 0, 3000, 7000, [
        { image: "easy.jpg", condition: "correct", bucket: "true-pass" },
      ]),
      makeRun(1, 1, 0, 3000, 7000, [
        { image: "easy.jpg", condition: "correct", bucket: "true-pass" },
      ]),
    ];
    const out = perImageConsistency(runs);
    const row = out.find((r) => r.image === "easy.jpg");
    expect(row?.classification).toBe("DETERMINISTIC_PASS");
  });

  it("flags an image as INCONSISTENT_BUT_FAILED when verdicts varied but never passed", () => {
    // Image FAILed in run 1 and REVIEWed in run 2 — verdicts vary
    // (it's not deterministic FAIL) but it never PASSED either.
    // Still a real defect, but the failure mode is unstable.
    const runs = [
      makeRun(0.5, 1, 0, 3000, 7000, [
        { image: "noisy.jpg", condition: "correct", bucket: "false-fail" },
      ]),
      makeRun(0.5, 1, 0, 3000, 7000, [
        { image: "noisy.jpg", condition: "correct", bucket: "review-on-correct" },
      ]),
    ];
    const out = perImageConsistency(runs);
    const row = out.find((r) => r.image === "noisy.jpg");
    expect(row?.classification).toBe("INCONSISTENT_NON_PASS");
  });

  it("classifies error-on-correct buckets as part of the non-pass family", () => {
    // An error every run is deterministic — usually a GT/schema defect.
    const runs = [
      makeRun(0.5, 1, 1, 3000, 7000, [
        { image: "broken.jpg", condition: "correct", bucket: "error-on-correct" },
      ]),
      makeRun(0.5, 1, 1, 3000, 7000, [
        { image: "broken.jpg", condition: "correct", bucket: "error-on-correct" },
      ]),
    ];
    const out = perImageConsistency(runs);
    const row = out.find((r) => r.image === "broken.jpg");
    expect(row?.classification).toBe("DETERMINISTIC_ERROR");
  });

  it("returns a per-condition row (correct vs wrong tracked separately)", () => {
    // Same image, different conditions = different rows.
    const runs = [
      makeRun(1, 1, 0, 3000, 7000, [
        { image: "x.jpg", condition: "correct", bucket: "true-pass" },
        { image: "x.jpg", condition: "wrong", bucket: "true-reject" },
      ]),
    ];
    const out = perImageConsistency(runs);
    expect(out.filter((r) => r.image === "x.jpg").length).toBe(2);
  });

  it("handles an empty run list defensively", () => {
    expect(perImageConsistency([])).toEqual([]);
  });
});
