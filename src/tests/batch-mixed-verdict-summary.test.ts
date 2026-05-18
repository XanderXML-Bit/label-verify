// Wave-35m — mixed-verdict batch summary aggregation.
//
// The /api/verify/batch response carries a `summary` object with
// `{passed, failed, review, errored}` counts that the UI's
// completion toast renders ("3 passed · 1 failed · 1 review ·
// 0 errored"). Reviewer trust hinges on that count being right —
// if the summary math drifts from the per-row results, a regulator
// could see "5/5 passed" while one row actually FAILED.
//
// This test submits a 4-item batch where verifyLabel returns one of
// each terminal state (pass, fail, review, throw) and confirms the
// summary aggregation is exactly {1, 1, 1, 1}.
//
// Why INLINE_BATCH_CONCURRENCY=1: the inline batch loop dynamically
// imports @/lib/verify inside `verifyLabelInline`. With vitest's
// vi.mock and N concurrent dynamic imports, one of the imports can
// race past the mock and resolve to the real module — making the
// mock's call counter unreliable. (Documented in the wave-35g
// CHANGELOG; surfaced as the reason api-batch-pairing-branches's
// happy-path test asserts on pairing layer outputs rather than the
// verifyLabelMock counter.) Forcing concurrency=1 serialises the
// inline loop so every dynamic import races against an idle event
// loop, eliminating the race entirely.

import { describe, expect, it, vi, beforeEach, afterEach } from "vitest";
import type { VerifyResponse } from "@/lib/types";

const verifyLabelMock = vi.fn();
vi.mock("@/lib/verify", () => ({
  verifyLabel: (...args: unknown[]) => verifyLabelMock(...args),
}));

import { POST } from "@/app/api/verify/batch/route";

const ORIGINAL_INLINE_CONCURRENCY = process.env.INLINE_BATCH_CONCURRENCY;

beforeEach(() => {
  // Force serial inline processing. See file header for rationale.
  process.env.INLINE_BATCH_CONCURRENCY = "1";
  verifyLabelMock.mockReset();
});

afterEach(() => {
  if (ORIGINAL_INLINE_CONCURRENCY === undefined) {
    delete process.env.INLINE_BATCH_CONCURRENCY;
  } else {
    process.env.INLINE_BATCH_CONCURRENCY = ORIGINAL_INLINE_CONCURRENCY;
  }
});

const TINY_JPEG = Buffer.from([0xff, 0xd8, 0xff]);

function jpegFile(name: string): File {
  const blob = new Blob([TINY_JPEG as unknown as BlobPart], { type: "image/jpeg" });
  return new File([blob], name, { type: "image/jpeg" });
}

function verifyResult(verdict: "pass" | "fail" | "review"): VerifyResponse {
  return {
    verdict,
    imageQuality: "good",
    fields: {} as VerifyResponse["fields"],
    governmentWarning: {} as VerifyResponse["governmentWarning"],
    extracted: {} as VerifyResponse["extracted"],
    timings: { preprocess: 1, ocr: null, vision: 1, matching: 1, total: 3 },
    modelId: "mock",
    modelVersion: "v1",
    modeUsed: "default",
    requiresHumanReview: false,
    reviewReasons: [],
  };
}

const DECLARED_BASE = {
  brand_name: "Mill Creek",
  class_type: "Pilsner",
  class_category: "beer" as const,
  abv_percent: 5.2,
  net_contents: "12 fl_oz",
  producer: "Mill Creek Beverage Co.",
  country_of_origin: "USA",
};

let ipCounter = 15_000;
function freshIp(): string {
  ipCounter++;
  return `198.18.${(ipCounter >> 8) & 0xff}.${ipCounter & 0xff}`;
}

describe("/api/verify/batch — mixed-verdict summary aggregation", () => {
  it("4-item batch with {pass, fail, review, throw} returns summary {1,1,1,1}", async () => {
    // Per-call mock: index 0 → pass, 1 → fail, 2 → review, 3 → throw.
    // With INLINE_BATCH_CONCURRENCY=1 the loop calls verifyLabel
    // sequentially in item-order, so the mock's per-call index
    // lines up with the manifest's row order.
    verifyLabelMock
      .mockResolvedValueOnce(verifyResult("pass"))
      .mockResolvedValueOnce(verifyResult("fail"))
      .mockResolvedValueOnce(verifyResult("review"))
      .mockRejectedValueOnce(new Error("synthetic vision failure"));
    const fd = new FormData();
    fd.append(
      "manifest",
      JSON.stringify([
        { filename: "a.jpg", ...DECLARED_BASE },
        { filename: "b.jpg", ...DECLARED_BASE },
        { filename: "c.jpg", ...DECLARED_BASE },
        { filename: "d.jpg", ...DECLARED_BASE },
      ]),
    );
    fd.append("image", jpegFile("a.jpg"));
    fd.append("image", jpegFile("b.jpg"));
    fd.append("image", jpegFile("c.jpg"));
    fd.append("image", jpegFile("d.jpg"));
    const req = new Request("http://test.local/api/verify/batch", {
      method: "POST",
      body: fd,
      headers: {
        "content-length": "1000",
        "x-forwarded-for": freshIp(),
      },
    });
    const resp = await POST(req);
    expect(resp.status).toBe(200);
    const body = (await resp.json()) as {
      count: number;
      results: Array<{ status: string; result?: { verdict: string }; error?: string }>;
      summary: { passed: number; failed: number; review: number; errored: number };
      inline: boolean;
    };
    expect(body.count).toBe(4);
    expect(body.inline).toBe(true);
    expect(body.results).toHaveLength(4);
    // Summary math is the load-bearing claim.
    expect(body.summary).toEqual({
      passed: 1,
      failed: 1,
      review: 1,
      errored: 1,
    });
    // And the per-row verdicts line up with the mock's per-call
    // index — important because the UI's per-row drilldown reads
    // each verdict separately, so an off-by-one in the inline loop
    // would silently mis-render which photo got which verdict.
    expect(body.results[0]?.status).toBe("done");
    expect(body.results[0]?.result?.verdict).toBe("pass");
    expect(body.results[1]?.result?.verdict).toBe("fail");
    expect(body.results[2]?.result?.verdict).toBe("review");
    expect(body.results[3]?.status).toBe("error");
    expect(body.results[3]?.error).toMatch(/synthetic vision failure/);
  });

  it("all-pass batch reports {N, 0, 0, 0} (regression guard on the happy path)", async () => {
    verifyLabelMock.mockResolvedValue(verifyResult("pass"));
    const fd = new FormData();
    fd.append(
      "manifest",
      JSON.stringify([
        { filename: "a.jpg", ...DECLARED_BASE },
        { filename: "b.jpg", ...DECLARED_BASE },
        { filename: "c.jpg", ...DECLARED_BASE },
      ]),
    );
    fd.append("image", jpegFile("a.jpg"));
    fd.append("image", jpegFile("b.jpg"));
    fd.append("image", jpegFile("c.jpg"));
    const req = new Request("http://test.local/api/verify/batch", {
      method: "POST",
      body: fd,
      headers: {
        "content-length": "1000",
        "x-forwarded-for": freshIp(),
      },
    });
    const resp = await POST(req);
    expect(resp.status).toBe(200);
    const body = (await resp.json()) as {
      summary: { passed: number; failed: number; review: number; errored: number };
    };
    expect(body.summary).toEqual({
      passed: 3,
      failed: 0,
      review: 0,
      errored: 0,
    });
  });

  it("all-error batch reports {0, 0, 0, N} (regression guard on the failure path)", async () => {
    verifyLabelMock.mockRejectedValue(new Error("provider 503"));
    const fd = new FormData();
    fd.append(
      "manifest",
      JSON.stringify([
        { filename: "a.jpg", ...DECLARED_BASE },
        { filename: "b.jpg", ...DECLARED_BASE },
      ]),
    );
    fd.append("image", jpegFile("a.jpg"));
    fd.append("image", jpegFile("b.jpg"));
    const req = new Request("http://test.local/api/verify/batch", {
      method: "POST",
      body: fd,
      headers: {
        "content-length": "1000",
        "x-forwarded-for": freshIp(),
      },
    });
    const resp = await POST(req);
    expect(resp.status).toBe(200);
    const body = (await resp.json()) as {
      summary: { passed: number; failed: number; review: number; errored: number };
    };
    // Errored items don't block the batch — each row independently
    // captures its error and the response still 200s. This is the
    // documented batch behaviour: partial failures surface in the
    // per-row results, not as an HTTP error.
    expect(body.summary).toEqual({
      passed: 0,
      failed: 0,
      review: 0,
      errored: 2,
    });
  });
});
