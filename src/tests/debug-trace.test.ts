import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  __resetTraceBufferForTests,
  TRACE_BUFFER_CAP,
  getRecentTraces,
  getTraceById,
  recordTrace,
  type VerifyTrace,
} from "@/lib/debug-trace";
import type { DeclaredFields, VerifyResponse } from "@/lib/types";
import { GET } from "@/app/api/debug/last/route";

// ─── Fixtures ──────────────────────────────────────────────────────────────

const DECLARED: DeclaredFields = {
  brand_name: "Stone's Throw Brewing",
  class_type: "India Pale Ale",
  class_category: "beer",
  abv_percent: 6.4,
  net_contents: { value: 12, unit: "fl_oz" },
  producer: "Stone's Throw Brewing Co.",
  country_of_origin: "USA",
};

// We don't exercise the response shape in these tests — only its identity
// inside a VerifyTrace. Build a minimal stand-in via an unknown cast; we
// never read from this object inside an assertion that depends on its
// internal structure.
function fakeResponse(): VerifyResponse {
  return {
    verdict: "pass",
    imageQuality: "good",
    fields: {},
    governmentWarning: {},
    extracted: {},
    timings: { preprocess: 1, ocr: 2, vision: 3, matching: 4, total: 10 },
    modelId: "mock:test",
    modelVersion: "mock-v1",
  } as unknown as VerifyResponse;
}

function makeTrace(id: string, receivedAt: number = Date.now()): VerifyTrace {
  return {
    id,
    receivedAt,
    declared: DECLARED,
    preprocessedDims: { w: 1600, h: 900 },
    modelId: "mock:test",
    modelVersion: "mock-v1",
    promptHash: "deadbeef",
    ocrText: "raw ocr text",
    rawExtraction: { example: true },
    response: fakeResponse(),
  };
}

// ─── Ring buffer ────────────────────────────────────────────────────────────

describe("debug-trace ring buffer", () => {
  beforeEach(() => __resetTraceBufferForTests());
  afterEach(() => __resetTraceBufferForTests());

  it("evicts the oldest entries beyond the cap of 20", () => {
    expect(TRACE_BUFFER_CAP).toBe(20);
    for (let i = 0; i < 25; i++) recordTrace(makeTrace(`t${i}`, i));
    const all = getRecentTraces(100);
    expect(all).toHaveLength(20);
    // First five (t0..t4) should be evicted; newest first.
    expect(all[0]?.id).toBe("t24");
    expect(all.at(-1)?.id).toBe("t5");
    expect(getTraceById("t0")).toBeUndefined();
  });

  it("getRecentTraces returns most-recent-first", () => {
    recordTrace(makeTrace("a", 1));
    recordTrace(makeTrace("b", 2));
    recordTrace(makeTrace("c", 3));
    const traces = getRecentTraces();
    expect(traces.map((t) => t.id)).toEqual(["c", "b", "a"]);
  });

  it("getTraceById round-trips and returns undefined for unknown ids", () => {
    const t = makeTrace("only-one");
    recordTrace(t);
    expect(getTraceById("only-one")?.id).toBe("only-one");
    expect(getTraceById("not-there")).toBeUndefined();
  });

  it("respects a small limit on getRecentTraces", () => {
    for (let i = 0; i < 5; i++) recordTrace(makeTrace(`x${i}`, i));
    const two = getRecentTraces(2);
    expect(two.map((t) => t.id)).toEqual(["x4", "x3"]);
  });
});

// ─── /api/debug/last route ──────────────────────────────────────────────────

function makeRequest(headers: Record<string, string> = {}, search: string = "") {
  return new Request(`http://localhost/api/debug/last${search}`, { headers });
}

describe("GET /api/debug/last", () => {
  const originalToken = process.env.DEBUG_TOKEN;
  beforeEach(() => __resetTraceBufferForTests());
  afterEach(() => {
    if (originalToken === undefined) delete process.env.DEBUG_TOKEN;
    else process.env.DEBUG_TOKEN = originalToken;
    __resetTraceBufferForTests();
  });

  it("returns 404 when DEBUG_TOKEN is unset", async () => {
    delete process.env.DEBUG_TOKEN;
    const res = await GET(
      makeRequest({ authorization: "Bearer anything" }),
    );
    expect(res.status).toBe(404);
  });

  it("returns 401 when the bearer token is wrong", async () => {
    process.env.DEBUG_TOKEN = "secret-shh";
    const res = await GET(makeRequest({ authorization: "Bearer wrong" }));
    expect(res.status).toBe(401);
  });

  it("returns 401 when no Authorization header is supplied", async () => {
    process.env.DEBUG_TOKEN = "secret-shh";
    const res = await GET(makeRequest({}));
    expect(res.status).toBe(401);
  });

  it("returns 200 with the recent traces when the bearer is right", async () => {
    process.env.DEBUG_TOKEN = "secret-shh";
    recordTrace(makeTrace("alpha", 1));
    recordTrace(makeTrace("beta", 2));
    const res = await GET(
      makeRequest({ authorization: "Bearer secret-shh" }),
    );
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      count: number;
      traces: VerifyTrace[];
    };
    expect(body.count).toBe(2);
    expect(body.traces[0]?.id).toBe("beta");
    expect(body.traces[1]?.id).toBe("alpha");
  });

  it("returns a single trace when ?id= matches", async () => {
    process.env.DEBUG_TOKEN = "secret-shh";
    recordTrace(makeTrace("alpha", 1));
    recordTrace(makeTrace("beta", 2));
    const res = await GET(
      makeRequest(
        { authorization: "Bearer secret-shh" },
        "?id=alpha",
      ),
    );
    expect(res.status).toBe(200);
    const body = (await res.json()) as { trace: VerifyTrace };
    expect(body.trace.id).toBe("alpha");
  });

  it("returns 404 when ?id= matches nothing", async () => {
    process.env.DEBUG_TOKEN = "secret-shh";
    const res = await GET(
      makeRequest(
        { authorization: "Bearer secret-shh" },
        "?id=missing",
      ),
    );
    expect(res.status).toBe(404);
  });

  it("redacts OCR text beyond 1000 chars", async () => {
    process.env.DEBUG_TOKEN = "secret-shh";
    const long = "x".repeat(2500);
    const trace = makeTrace("long");
    recordTrace({ ...trace, ocrText: long });
    const res = await GET(
      makeRequest(
        { authorization: "Bearer secret-shh" },
        "?id=long",
      ),
    );
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      trace: VerifyTrace & { ocrTextTruncated: boolean };
    };
    expect(body.trace.ocrText?.length).toBe(1000);
    expect(body.trace.ocrTextTruncated).toBe(true);
  });
});
