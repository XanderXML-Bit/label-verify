import { describe, expect, it } from "vitest";
import { GET } from "@/app/api/health/route";

// The /api/health endpoint returns one of two shapes based on the caller:
//   - Public (anonymous, no DEBUG_TOKEN, no same-origin referer): only
//     { ok, service, ready }. Hides version/model/providers.
//   - Privileged (same-origin OR Bearer DEBUG_TOKEN, OR no token set
//     at all): includes all diagnostic detail. ApiStatusBanner uses
//     the privileged path via same-origin referer.

function makeReq(opts: { auth?: string; referer?: string; host?: string } = {}): Request {
  const headers: Record<string, string> = {};
  if (opts.auth) headers.authorization = opts.auth;
  if (opts.referer) headers.referer = opts.referer;
  headers.host = opts.host ?? "test.local";
  return new Request("http://test.local/api/health", { headers });
}

describe("/api/health public path (anonymous, cross-origin)", () => {
  // Cross-origin request without a Bearer token AND without
  // a same-origin referer. In the test runtime DEBUG_TOKEN is also
  // unset, so we have to set one to force the public branch.
  const realDebugToken = process.env.DEBUG_TOKEN;

  it("returns 200 with the minimal public shape (no version, no providers)", async () => {
    process.env.DEBUG_TOKEN = "test-token-secret";
    try {
      const resp = await GET(
        makeReq({ referer: "https://malicious.example.com/" }),
      );
      expect(resp.status).toBe(200);
      const body = (await resp.json()) as Record<string, unknown>;
      expect(body.ok).toBe(true);
      expect(body.service).toBe("label-verify");
      expect(typeof body.ready).toBe("boolean");
      expect("version" in body).toBe(false);
      expect("model" in body).toBe(false);
      expect("providers" in body).toBe(false);
    } finally {
      if (realDebugToken === undefined) delete process.env.DEBUG_TOKEN;
      else process.env.DEBUG_TOKEN = realDebugToken;
    }
  });
});

describe("/api/health privileged paths", () => {
  it("returns detail to a same-origin caller", async () => {
    const resp = await GET(
      makeReq({ referer: "http://test.local/", host: "test.local" }),
    );
    expect(resp.status).toBe(200);
    const body = (await resp.json()) as Record<string, unknown>;
    expect(body.ok).toBe(true);
    expect(body.service).toBe("label-verify");
    expect(typeof body.model).toBe("string");
    expect((body.model as string).length).toBeGreaterThan(0);
    expect(typeof body.version).toBe("string");
    expect("providers" in body).toBe(true);
    expect("ready" in body).toBe(true);
  });

  it("returns detail to a Bearer-authed caller", async () => {
    const realDebugToken = process.env.DEBUG_TOKEN;
    process.env.DEBUG_TOKEN = "test-token-secret";
    try {
      const resp = await GET(makeReq({ auth: "Bearer test-token-secret" }));
      expect(resp.status).toBe(200);
      const body = (await resp.json()) as Record<string, unknown>;
      expect("providers" in body).toBe(true);
    } finally {
      if (realDebugToken === undefined) delete process.env.DEBUG_TOKEN;
      else process.env.DEBUG_TOKEN = realDebugToken;
    }
  });

  it("includes an ISO-8601 timestamp in the detailed shape", async () => {
    const before = Date.now();
    const resp = await GET(
      makeReq({ referer: "http://test.local/", host: "test.local" }),
    );
    const body = (await resp.json()) as { timestamp: string };
    const parsed = Date.parse(body.timestamp);
    expect(Number.isFinite(parsed)).toBe(true);
    expect(Math.abs(parsed - before)).toBeLessThan(5_000);
    expect(body.timestamp).toMatch(/^\d{4}-\d{2}-\d{2}T/);
  });
});
