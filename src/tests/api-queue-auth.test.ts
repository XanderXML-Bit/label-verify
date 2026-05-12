import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { GET } from "@/app/api/queue/route";

// /api/queue is Bearer-gated post-consolidation. The route's auth
// contract mirrors /api/debug/last:
//   - DEBUG_TOKEN unset → 404 (route looks like it doesn't exist;
//     no deployment fingerprint)
//   - DEBUG_TOKEN set, wrong/missing bearer → 401
//   - DEBUG_TOKEN set, correct bearer → 200

function makeReq(headers: Record<string, string> = {}): Request {
  const h = new Headers(headers);
  return new Request("http://test.local/api/queue", { headers: h });
}

describe("/api/queue auth", () => {
  const originalToken = process.env.DEBUG_TOKEN;

  beforeEach(() => {
    delete process.env.DEBUG_TOKEN;
  });
  afterEach(() => {
    if (originalToken === undefined) delete process.env.DEBUG_TOKEN;
    else process.env.DEBUG_TOKEN = originalToken;
  });

  it("returns 404 when DEBUG_TOKEN is unset, regardless of bearer header", async () => {
    delete process.env.DEBUG_TOKEN;
    const resp = await GET(makeReq({ authorization: "Bearer anything" }));
    expect(resp.status).toBe(404);
  });

  it("returns 401 when DEBUG_TOKEN is set but no bearer is sent", async () => {
    process.env.DEBUG_TOKEN = "test-secret-token-12345";
    const resp = await GET(makeReq());
    expect(resp.status).toBe(401);
  });

  it("returns 401 when bearer mismatches DEBUG_TOKEN", async () => {
    process.env.DEBUG_TOKEN = "test-secret-token-12345";
    const resp = await GET(makeReq({ authorization: "Bearer wrong-token" }));
    expect(resp.status).toBe(401);
  });

  it("returns 200 + stats/items when bearer matches DEBUG_TOKEN", async () => {
    process.env.DEBUG_TOKEN = "test-secret-token-12345";
    const resp = await GET(
      makeReq({ authorization: "Bearer test-secret-token-12345" }),
    );
    expect(resp.status).toBe(200);
    const body = (await resp.json()) as { stats: unknown; items: unknown[] };
    expect(body.stats).toBeDefined();
    expect(Array.isArray(body.items)).toBe(true);
  });

  it("treats Bearer-prefix variants strictly (lowercase 'bearer' is rejected)", async () => {
    // checkDebugBearer requires the exact 'Bearer ' prefix. A
    // lowercase 'bearer' or a missing space would mismatch.
    process.env.DEBUG_TOKEN = "test-secret-token-12345";
    const resp = await GET(
      makeReq({ authorization: "bearer test-secret-token-12345" }),
    );
    expect(resp.status).toBe(401);
  });
});
