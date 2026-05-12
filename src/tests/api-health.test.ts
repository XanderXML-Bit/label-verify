import { describe, expect, it } from "vitest";
import { GET } from "@/app/api/health/route";

// /api/health has two shapes:
//   - Public: anonymous callers receive only { ok, service, ready }.
//   - Detailed: requires Authorization: Bearer DEBUG_TOKEN. Referer/host are
//     intentionally ignored because clients can spoof them.

function makeReq(opts: { auth?: string; referer?: string; host?: string } = {}): Request {
  const headers: Record<string, string> = {};
  if (opts.auth) headers.authorization = opts.auth;
  if (opts.referer) headers.referer = opts.referer;
  headers.host = opts.host ?? "test.local";
  return new Request("http://test.local/api/health", { headers });
}

function withDebugToken<T>(token: string, fn: () => Promise<T>): Promise<T> {
  const realDebugToken = process.env.DEBUG_TOKEN;
  process.env.DEBUG_TOKEN = token;
  return fn().finally(() => {
    if (realDebugToken === undefined) delete process.env.DEBUG_TOKEN;
    else process.env.DEBUG_TOKEN = realDebugToken;
  });
}

describe("/api/health public path", () => {
  it("returns 200 with the minimal public shape (no version, no providers)", async () => {
    await withDebugToken("test-token-secret", async () => {
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
    });
  });

  it("does not trust spoofable same-origin Referer for detailed diagnostics", async () => {
    await withDebugToken("test-token-secret", async () => {
      const resp = await GET(
        makeReq({ referer: "http://test.local/", host: "test.local" }),
      );
      const body = (await resp.json()) as Record<string, unknown>;
      expect("model" in body).toBe(false);
      expect("providers" in body).toBe(false);
      expect("version" in body).toBe(false);
    });
  });
});

describe("/api/health privileged paths", () => {
  it("returns detail to a Bearer-authed caller", async () => {
    await withDebugToken("test-token-secret", async () => {
      const resp = await GET(makeReq({ auth: "Bearer test-token-secret" }));
      expect(resp.status).toBe(200);
      const body = (await resp.json()) as Record<string, unknown>;
      expect(typeof body.model).toBe("string");
      expect(typeof body.version).toBe("string");
      expect("providers" in body).toBe(true);
      expect("ready" in body).toBe(true);
    });
  });

  it("includes an ISO-8601 timestamp in the detailed shape", async () => {
    await withDebugToken("test-token-secret", async () => {
      const before = Date.now();
      const resp = await GET(makeReq({ auth: "Bearer test-token-secret" }));
      const body = (await resp.json()) as { timestamp: string };
      const parsed = Date.parse(body.timestamp);
      expect(Number.isFinite(parsed)).toBe(true);
      expect(Math.abs(parsed - before)).toBeLessThan(5_000);
      expect(body.timestamp).toMatch(/^\d{4}-\d{2}-\d{2}T/);
    });
  });
});
