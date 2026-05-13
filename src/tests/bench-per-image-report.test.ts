import { describe, expect, it } from "vitest";
import { renderPerImageMarkdown, type PerImageRecord } from "@/lib/bench-per-image-report";
import type { DeclaredFields } from "@/lib/types";

const declared: DeclaredFields = {
  brand_name: "Acme",
  class_type: "vodka",
  class_category: "distilled_spirits",
  abv_percent: 40,
  net_contents: { value: 750, unit: "ml" },
  producer: "Acme Distillery",
  country_of_origin: "USA",
};

const baseRecord: PerImageRecord = {
  image: "lbl-001.jpg",
  condition: "correct",
  expected: "pass",
  actual: "pass",
  bucket: "true-pass",
  imageQuality: "good",
  govWarningCase: "C0",
  elapsedMs: 3200,
  declared,
  gtPath: "test-data/ground-truth/lbl-001.json",
};

describe("renderPerImageMarkdown", () => {
  it("emits a run header with summary metrics", () => {
    const md = renderPerImageMarkdown({
      corpus: "test-data-combined",
      runAt: "2026-05-13T17:00:00Z",
      commit: "abc1234",
      summary: {
        images: 170,
        tasks: 340,
        completed: 340,
        errors: 5,
        passRateOnCorrect: 0.7653,
        failOrReviewRateOnWrong: 1.0,
      },
      records: [baseRecord],
    });
    expect(md).toContain("# Cross-pair bench — per-image trace");
    expect(md).toContain("test-data-combined");
    expect(md).toContain("abc1234");
    expect(md).toContain("170 images");
    expect(md).toContain("340 tasks");
    expect(md).toContain("76.5%"); // pass-rate-on-correct
    expect(md).toContain("100.0%"); // fail/review-on-wrong
    expect(md).toContain("5"); // errors
  });

  it("groups records under bucket headings in operator-priority order", () => {
    const md = renderPerImageMarkdown({
      corpus: "test-data-combined",
      runAt: "2026-05-13T17:00:00Z",
      commit: null,
      summary: {
        images: 1,
        tasks: 2,
        completed: 2,
        errors: 1,
        passRateOnCorrect: 0,
        failOrReviewRateOnWrong: 0,
      },
      records: [
        { ...baseRecord, image: "good.jpg", bucket: "true-pass" },
        {
          ...baseRecord,
          image: "boom.jpg",
          actual: "error",
          bucket: "error-on-correct",
          error: "fetch failed",
        },
      ],
    });
    // Errors must come BEFORE the happy-path section.
    const errorIdx = md.indexOf("## Errors");
    const passIdx = md.indexOf("True pass");
    expect(errorIdx).toBeGreaterThan(-1);
    expect(passIdx).toBeGreaterThan(-1);
    expect(errorIdx).toBeLessThan(passIdx);
    // Specific error surfaced with the offending image name.
    expect(md).toContain("boom.jpg");
    expect(md).toContain("fetch failed");
  });

  it("renders the declared fields per record (application data binding)", () => {
    const md = renderPerImageMarkdown({
      corpus: "test-data-combined",
      runAt: "2026-05-13T17:00:00Z",
      commit: null,
      summary: {
        images: 1,
        tasks: 1,
        completed: 1,
        errors: 0,
        passRateOnCorrect: 1,
        failOrReviewRateOnWrong: 0,
      },
      records: [
        {
          ...baseRecord,
          image: "vodka-001.jpg",
          actual: "fail",
          bucket: "false-fail",
        },
      ],
    });
    // The declared fields should be visible in the false-fail section
    // so the reviewer can correlate "we said fail on this label
    // against this declared payload."
    expect(md).toContain("vodka-001.jpg");
    expect(md).toContain("Acme");
    expect(md).toContain("40");
    expect(md).toContain("USA");
  });

  it("surfaces every false-positive (regulator-dangerous bucket) with full context", () => {
    const md = renderPerImageMarkdown({
      corpus: "test-data-combined",
      runAt: "2026-05-13T17:00:00Z",
      commit: null,
      summary: {
        images: 1,
        tasks: 1,
        completed: 1,
        errors: 0,
        passRateOnCorrect: 1,
        failOrReviewRateOnWrong: 0.667,
      },
      records: [
        {
          ...baseRecord,
          image: "spirits-014.jpg",
          condition: "wrong",
          expected: "fail",
          actual: "pass",
          bucket: "false-pass-on-wrong",
          govWarningCase: "S3",
        },
      ],
    });
    expect(md).toContain("## False positives");
    expect(md).toContain("spirits-014.jpg");
    expect(md).toContain("S3");
  });

  it("provides a summary table for true-reject (large bucket on a healthy run)", () => {
    // 50 true-rejects shouldn't get individual sections — just a
    // one-line summary line so the report stays readable.
    const records: PerImageRecord[] = Array.from({ length: 50 }, (_, i) => ({
      ...baseRecord,
      image: `wrong-${i.toString().padStart(3, "0")}.jpg`,
      condition: "wrong",
      expected: "fail",
      actual: "fail",
      bucket: "true-reject",
    }));
    const md = renderPerImageMarkdown({
      corpus: "test-data-combined",
      runAt: "2026-05-13T17:00:00Z",
      commit: null,
      summary: {
        images: 50,
        tasks: 50,
        completed: 50,
        errors: 0,
        passRateOnCorrect: 0,
        failOrReviewRateOnWrong: 1,
      },
      records,
    });
    expect(md).toContain("## Happy path (summary)");
    expect(md).toMatch(/True rejects:\s*50/);
    // Should NOT enumerate all 50 — that would balloon the report.
    expect((md.match(/wrong-/g) ?? []).length).toBeLessThan(10);
  });

  it("does not crash when records list is empty", () => {
    const md = renderPerImageMarkdown({
      corpus: "test-data-combined",
      runAt: "2026-05-13T17:00:00Z",
      commit: null,
      summary: {
        images: 0,
        tasks: 0,
        completed: 0,
        errors: 0,
        passRateOnCorrect: 0,
        failOrReviewRateOnWrong: 0,
      },
      records: [],
    });
    expect(md).toContain("# Cross-pair bench");
    expect(md).toContain("No tasks completed");
  });
});
