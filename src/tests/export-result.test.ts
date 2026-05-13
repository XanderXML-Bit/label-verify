import { describe, expect, it } from "vitest";
import type { VerifyResponse } from "@/lib/types";
import {
  batchToCsv,
  batchToJson,
  safeStem,
  singleResultToCsv,
  singleResultToJson,
} from "@/lib/export-result";

function fakeResult(overrides: Partial<VerifyResponse> = {}): VerifyResponse {
  const base: VerifyResponse = {
    verdict: "pass",
    imageQuality: "good",
    fields: {
      brand_name: {
        field: "brand_name",
        status: "pass",
        expected: "ACME",
        actual: "ACME",
        confidence: 0.95,
      },
      class_type: {
        field: "class_type",
        status: "pass",
        expected: "Lager",
        actual: "Lager",
        confidence: 0.91,
      },
      abv_percent: {
        field: "abv_percent",
        status: "pass",
        expected: 5.2,
        actual: 5.2,
        confidence: 0.99,
      },
      net_contents: {
        field: "net_contents",
        status: "pass",
        expected: { value: 12, unit: "fl_oz" },
        actual: { value: 12, unit: "fl_oz" },
        confidence: 0.9,
      },
      producer: {
        field: "producer",
        status: "pass",
        expected: "ACME Co.",
        actual: "ACME Co.",
        confidence: 0.88,
      },
      country_of_origin: {
        field: "country_of_origin",
        status: "pass",
        expected: "USA",
        actual: "USA",
        confidence: 0.97,
      },
    },
    governmentWarning: {
      status: "pass",
      confidence: 0.95,
      subscores: {
        text: { status: "pass", confidence: 1.0 },
        caps: { status: "pass", confidence: 1.0 },
        bold: { status: "pass", confidence: 0.9 },
        size: { status: "pass", confidence: 0.85 },
      },
    },
    extracted: {} as never, // not used by exporters
    timings: {
      preprocess: 120,
      ocr: 800,
      vision: 1800,
      matching: 50,
      total: 2800,
    },
    modelId: "gemini:gemini-3.1-flash-lite",
    modelVersion: "gemini-3.1-flash-lite",
    modeUsed: "default",
    requiresHumanReview: false,
    reviewReasons: [],
  };
  return { ...base, ...overrides };
}

describe("export-result — CSV", () => {
  it("singleResultToCsv emits exactly one data row + header", () => {
    const csv = singleResultToCsv("acme.jpg", fakeResult());
    const lines = csv.trim().split("\n");
    expect(lines).toHaveLength(2); // header + 1 row
    expect(lines[0]).toContain("verdict");
    expect(lines[0]).toContain("gov_warning_text");
    expect(lines[1]).toContain(`"acme.jpg"`);
    expect(lines[1]).toContain(`"pass"`);
  });

  it("singleResultToCsv emits per-field confidence with 3-digit precision", () => {
    const csv = singleResultToCsv("a.jpg", fakeResult());
    // brand_confidence column should include 0.950 (formatted to 3 places).
    expect(csv).toContain(`"0.950"`);
    expect(csv).toContain(`"0.910"`); // class confidence
  });

  it("batchToCsv keeps a stable column shape for pending / running / error rows", () => {
    const csv = batchToCsv([
      { index: 0, filename: "ok.jpg", status: "done", result: fakeResult() },
      { index: 1, filename: "wait.jpg", status: "pending" },
      { index: 2, filename: "broke.jpg", status: "error", error: "boom" },
    ]);
    const lines = csv.trim().split("\n");
    expect(lines).toHaveLength(4); // header + 3 rows
    // Every body row has the same number of columns as the header.
    const headerCols = lines[0]!.split(",").length;
    for (let i = 1; i < lines.length; i++) {
      expect(lines[i]!.split(",").length, `row ${i}`).toBe(headerCols);
    }
    // Error message lands in the review_reasons column to keep the
    // verdict column free for the actual status word.
    expect(lines[3]).toContain(`"broke.jpg"`);
    expect(lines[3]).toContain(`"error"`);
    expect(lines[3]).toContain(`"boom"`);
  });

  it("CSV escapes embedded double-quotes correctly", () => {
    const withQuoteInReason = fakeResult({
      verdict: "review",
      reviewReasons: [`Producer name has a "quoted" segment.`],
    });
    const csv = singleResultToCsv("a.jpg", withQuoteInReason);
    // RFC 4180: double-quote inside a quoted field is escaped by
    // doubling — `"quoted"` → `""quoted""`.
    expect(csv).toContain(`""quoted""`);
  });

  it("CSV neutralizes formula-injection prefixes per OWASP", () => {
    // A malicious filename or model-derived reason that starts with =,
    // +, -, @, tab, or CR auto-executes as a spreadsheet formula on
    // open in Excel/Sheets/LibreOffice. We prefix a leading apostrophe
    // so the cell is treated as literal text. Regression test for the
    // multi-audit finding (Hermes + code review + Codex agree).
    const mal = fakeResult({
      verdict: "review",
      reviewReasons: [
        "=SUM(A1:A10)",
        "+1234567890",
        "-1",
        "@import",
        "\tstart with tab",
        "normal reason",
      ],
    });
    const csv = singleResultToCsv("=cmd|' /C calc'!A0.jpg", mal);
    // Filename column should be neutralized.
    expect(csv).toContain(`"'=cmd|' /C calc'!A0.jpg"`);
    // review_reasons concatenates with ' | ', and the very first char
    // is `=`, which must be prefixed.
    expect(csv).toContain(`"'=SUM(A1:A10) | +1234567890`);
    // Sanity: an actual benign string is NOT prefixed.
    expect(csv).toContain(`"pass"`);
    expect(csv).not.toContain(`"'pass"`);
  });
});

describe("export-result — JSON", () => {
  it("singleResultToJson emits the v1 schema envelope", () => {
    const json = singleResultToJson("acme.jpg", fakeResult());
    const parsed = JSON.parse(json) as Record<string, unknown>;
    expect(parsed.schema).toBe("labelverify.v1.single");
    expect(typeof parsed.exportedAt).toBe("string");
    expect(parsed.filename).toBe("acme.jpg");
    expect((parsed.result as { verdict: string }).verdict).toBe("pass");
  });

  it("batchToJson tallies passed / failed / review / errored", () => {
    const rows: Parameters<typeof batchToJson>[0] = [
      { index: 0, filename: "p.jpg", status: "done", result: fakeResult({ verdict: "pass" }) },
      { index: 1, filename: "f.jpg", status: "done", result: fakeResult({ verdict: "fail" }) },
      { index: 2, filename: "r.jpg", status: "done", result: fakeResult({ verdict: "review" }) },
      { index: 3, filename: "e.jpg", status: "error", error: "boom" },
    ];
    const json = JSON.parse(batchToJson(rows)) as {
      schema: string;
      count: number;
      passed: number;
      failed: number;
      review: number;
      errored: number;
      items: unknown[];
    };
    expect(json.schema).toBe("labelverify.v1.batch");
    expect(json.count).toBe(4);
    expect(json.passed).toBe(1);
    expect(json.failed).toBe(1);
    expect(json.review).toBe(1);
    expect(json.errored).toBe(1);
    expect(json.items).toHaveLength(4);
  });
});

describe("export-result — safeStem", () => {
  it("strips path + extension + unsafe chars", () => {
    expect(safeStem("subdir/ACME Vodka.JPG")).toBe("ACME-Vodka");
    expect(safeStem("../../etc/passwd")).toBe("passwd");
    expect(safeStem("file with spaces!@#.png")).toBe("file-with-spaces");
  });

  it("falls back to 'label' for an extension-only filename", () => {
    expect(safeStem(".jpg")).toBe("label");
  });

  it("preserves underscores as legitimate filesystem characters", () => {
    expect(safeStem("my_label.png")).toBe("my_label");
    expect(safeStem("___.png")).toBe("___");
  });
});
