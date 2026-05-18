// Wave-35f — coverage on /api/debug/last redaction cap.
//
// The wave-35e code-audit flagged the `OCR_REDACTION_CAP = 1000`
// constant as a privacy regression risk: a regression that shipped
// a 50 KB OCR dump on the debug endpoint would be a real privacy
// issue — operators authenticating to /api/debug/last for triage
// don't need to see every word the OCR pass found, only enough
// context to understand the verifier's behaviour.
//
// These tests pin: (a) the cap; (b) the `ocrTextTruncated` flag is
// surfaced when truncation occurs; (c) traces with `ocrText: null`
// pass through unchanged.

import { describe, expect, it, beforeEach, afterEach, vi } from "vitest";

const ORIGINAL_TOKEN = process.env.DEBUG_TOKEN;

beforeEach(async () => {
  process.env.DEBUG_TOKEN = "test-secret-token";
  vi.resetModules();
  const { __resetTraceBufferForTests } = await import("@/lib/debug-trace");
  __resetTraceBufferForTests();
});

afterEach(() => {
  if (ORIGINAL_TOKEN === undefined) {
    delete process.env.DEBUG_TOKEN;
  } else {
    process.env.DEBUG_TOKEN = ORIGINAL_TOKEN;
  }
  vi.restoreAllMocks();
});

function makeRequest(headers: Record<string, string> = {}): Request {
  return new Request("http://test.local/api/debug/last", {
    method: "GET",
    headers,
  });
}

describe("/api/debug/last — OCR redaction cap (privacy invariant)", () => {
  it("truncates ocrText longer than 1000 chars and sets ocrTextTruncated: true", async () => {
    const { recordTrace } = await import("@/lib/debug-trace");
    const { GET } = await import("@/app/api/debug/last/route");
    // 2500-char OCR dump — well past the 1000-char cap.
    const huge = "A".repeat(2500);
    recordTrace({
      id: "trace-1",
      receivedAt: Date.now(),
      declared: {
        brand_name: "Test",
        class_type: "IPA",
        class_category: "beer",
        abv_percent: 6.4,
        net_contents: { value: 12, unit: "fl_oz" },
        producer: "Test Co",
        country_of_origin: "USA",
      },
      preprocessedDims: { w: 100, h: 100 },
      modelId: "mock",
      modelVersion: "v1",
      promptHash: "x",
      ocrText: huge,
      rawExtraction: {},
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      response: {} as any,
    });
    const resp = await GET(
      makeRequest({ Authorization: "Bearer test-secret-token" }),
    );
    expect(resp.status).toBe(200);
    const body = (await resp.json()) as {
      traces: Array<{
        ocrText: string | null;
        ocrTextTruncated: boolean;
      }>;
    };
    expect(body.traces).toHaveLength(1);
    const t = body.traces[0]!;
    expect(t.ocrTextTruncated).toBe(true);
    // The body MUST be exactly 1000 chars — no off-by-one regression.
    expect(t.ocrText).toHaveLength(1000);
  });

  it("leaves ocrText UNCHANGED when ≤ 1000 chars, with ocrTextTruncated: false", async () => {
    const { recordTrace } = await import("@/lib/debug-trace");
    const { GET } = await import("@/app/api/debug/last/route");
    const short = "GOVERNMENT WARNING short OCR dump";
    recordTrace({
      id: "trace-2",
      receivedAt: Date.now(),
      declared: {
        brand_name: "Test",
        class_type: "IPA",
        class_category: "beer",
        abv_percent: 6.4,
        net_contents: { value: 12, unit: "fl_oz" },
        producer: "Test Co",
        country_of_origin: "USA",
      },
      preprocessedDims: { w: 100, h: 100 },
      modelId: "mock",
      modelVersion: "v1",
      promptHash: "x",
      ocrText: short,
      rawExtraction: {},
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      response: {} as any,
    });
    const resp = await GET(
      makeRequest({ Authorization: "Bearer test-secret-token" }),
    );
    expect(resp.status).toBe(200);
    const body = (await resp.json()) as {
      traces: Array<{ ocrText: string | null; ocrTextTruncated: boolean }>;
    };
    const t = body.traces[0]!;
    expect(t.ocrText).toBe(short);
    expect(t.ocrTextTruncated).toBe(false);
  });

  it("passes through ocrText: null unchanged (vision-only path; no OCR)", async () => {
    const { recordTrace } = await import("@/lib/debug-trace");
    const { GET } = await import("@/app/api/debug/last/route");
    recordTrace({
      id: "trace-3",
      receivedAt: Date.now(),
      declared: {
        brand_name: "Test",
        class_type: "IPA",
        class_category: "beer",
        abv_percent: 6.4,
        net_contents: { value: 12, unit: "fl_oz" },
        producer: "Test Co",
        country_of_origin: "USA",
      },
      preprocessedDims: { w: 100, h: 100 },
      modelId: "mock",
      modelVersion: "v1",
      promptHash: "x",
      ocrText: null,
      rawExtraction: {},
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      response: {} as any,
    });
    const resp = await GET(
      makeRequest({ Authorization: "Bearer test-secret-token" }),
    );
    expect(resp.status).toBe(200);
    const body = (await resp.json()) as {
      traces: Array<{ ocrText: string | null; ocrTextTruncated: boolean }>;
    };
    const t = body.traces[0]!;
    expect(t.ocrText).toBeNull();
    expect(t.ocrTextTruncated).toBe(false);
  });

  it("EXACTLY 1000-char ocrText does NOT get the truncated flag (boundary)", async () => {
    const { recordTrace } = await import("@/lib/debug-trace");
    const { GET } = await import("@/app/api/debug/last/route");
    const exact1000 = "B".repeat(1000);
    recordTrace({
      id: "trace-4",
      receivedAt: Date.now(),
      declared: {
        brand_name: "Test",
        class_type: "IPA",
        class_category: "beer",
        abv_percent: 6.4,
        net_contents: { value: 12, unit: "fl_oz" },
        producer: "Test Co",
        country_of_origin: "USA",
      },
      preprocessedDims: { w: 100, h: 100 },
      modelId: "mock",
      modelVersion: "v1",
      promptHash: "x",
      ocrText: exact1000,
      rawExtraction: {},
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      response: {} as any,
    });
    const resp = await GET(
      makeRequest({ Authorization: "Bearer test-secret-token" }),
    );
    const body = (await resp.json()) as {
      traces: Array<{ ocrText: string | null; ocrTextTruncated: boolean }>;
    };
    const t = body.traces[0]!;
    // Boundary check: length === cap means NOT truncated.
    expect(t.ocrText).toBe(exact1000);
    expect(t.ocrTextTruncated).toBe(false);
  });
});

describe("/api/debug/last — source pin for the 1000-char cap", () => {
  it("OCR_REDACTION_CAP constant remains 1000 (pinned by source inspection)", async () => {
    const fs = await import("node:fs");
    const src = fs.readFileSync(
      "src/app/api/debug/last/route.ts",
      "utf-8",
    );
    expect(src).toMatch(/const\s+OCR_REDACTION_CAP\s*=\s*1000/);
  });
});
