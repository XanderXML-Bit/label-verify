import { describe, expect, it } from "vitest";
import {
  classifyBucket,
  bucketLabel,
  BUCKETS,
  type Bucket,
} from "@/lib/bench-classify";

// The classifier is a strict 7-bucket projection of the
// (condition, expected, actual) triple. These tests document the
// projection so future contributors don't have to re-derive the
// table from the docstring — every code path is exercised here.

describe("classifyBucket", () => {
  it("(correct, pass, pass) → true-pass", () => {
    expect(
      classifyBucket({ condition: "correct", expected: "pass", actual: "pass" }),
    ).toBe<Bucket>("true-pass");
  });

  it("(correct, pass, fail) → false-fail (operator-cost FN)", () => {
    expect(
      classifyBucket({ condition: "correct", expected: "pass", actual: "fail" }),
    ).toBe<Bucket>("false-fail");
  });

  it("(correct, pass, review) → review-on-correct (friction, not a defect)", () => {
    expect(
      classifyBucket({
        condition: "correct",
        expected: "pass",
        actual: "review",
      }),
    ).toBe<Bucket>("review-on-correct");
  });

  it("(correct, fail, fail) → true-fail (compliant GT but non-compliant label)", () => {
    expect(
      classifyBucket({ condition: "correct", expected: "fail", actual: "fail" }),
    ).toBe<Bucket>("true-fail");
  });

  it("(correct, fail, pass) → false-pass-on-correct (rare; GT says fail but verifier passed)", () => {
    expect(
      classifyBucket({ condition: "correct", expected: "fail", actual: "pass" }),
    ).toBe<Bucket>("false-pass-on-correct");
  });

  it("(correct, fail, review) → review-on-correct", () => {
    // Reviews on the correct-condition side, regardless of expected
    // verdict, fall into the same bucket — they're all "the verifier
    // wanted human eyeballs on a paired-correctly GT input."
    expect(
      classifyBucket({
        condition: "correct",
        expected: "fail",
        actual: "review",
      }),
    ).toBe<Bucket>("review-on-correct");
  });

  it("(correct, *, error) → error-on-correct", () => {
    expect(
      classifyBucket({
        condition: "correct",
        expected: "pass",
        actual: "error",
      }),
    ).toBe<Bucket>("error-on-correct");
    expect(
      classifyBucket({
        condition: "correct",
        expected: "fail",
        actual: "error",
      }),
    ).toBe<Bucket>("error-on-correct");
  });

  it("(wrong, fail, fail) → true-reject", () => {
    expect(
      classifyBucket({ condition: "wrong", expected: "fail", actual: "fail" }),
    ).toBe<Bucket>("true-reject");
  });

  it("(wrong, fail, pass) → false-pass-on-wrong (regulator-dangerous FP)", () => {
    expect(
      classifyBucket({ condition: "wrong", expected: "fail", actual: "pass" }),
    ).toBe<Bucket>("false-pass-on-wrong");
  });

  it("(wrong, fail, review) → review-on-wrong (REVIEW-deferral safety net firing)", () => {
    expect(
      classifyBucket({
        condition: "wrong",
        expected: "fail",
        actual: "review",
      }),
    ).toBe<Bucket>("review-on-wrong");
  });

  it("(wrong, *, error) → error-on-wrong", () => {
    expect(
      classifyBucket({
        condition: "wrong",
        expected: "fail",
        actual: "error",
      }),
    ).toBe<Bucket>("error-on-wrong");
  });
});

describe("bucketLabel", () => {
  it("returns a human-readable label for every bucket", () => {
    for (const b of BUCKETS) {
      const label = bucketLabel(b);
      expect(typeof label).toBe("string");
      expect(label.length).toBeGreaterThan(0);
      // No raw underscores leak through.
      expect(label).not.toMatch(/[a-z]_[a-z]/);
    }
  });

  it("matches the documented user-facing taxonomy", () => {
    expect(bucketLabel("true-pass")).toMatch(/pass/i);
    expect(bucketLabel("false-fail")).toMatch(/false[ -]?negative|false[ -]?fail/i);
    expect(bucketLabel("false-pass-on-wrong")).toMatch(/false[ -]?positive/i);
    expect(bucketLabel("error-on-correct")).toMatch(/error/i);
  });
});

describe("BUCKETS", () => {
  it("enumerates all 9 buckets exactly once", () => {
    expect(new Set(BUCKETS).size).toBe(BUCKETS.length);
    expect(BUCKETS.length).toBe(9);
  });
});
