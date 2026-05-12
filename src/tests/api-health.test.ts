import { describe, expect, it } from "vitest";
import { GET } from "@/app/api/health/route";

// /api/health returns one of two shapes:
//   - Public (anonymous OR no DEBUG_TOKEN configured): only
//     { ok, service, ready, notes }. No provider matrix or version,
//     so the route cannot be used as a deployment fingerprint.
//   - Privileged (Bearer DEBUG_TOKEN matches): includes all
//     diagnostic detail.
// 2026-05-12 audit D12: the same-origin referer shortcut was
// removed — Referer is trivially spoofable so it cannot stand in for
// authentication.

function makeReq(opts: { auth?: string; referer?: string; host?: string } = {}): Request {
  const headers: Record<string, string> = {};
  if (opts.auth) headers.authorization = opts.auth;
  if (opts.referer) headers.referer = opts.referer;
  headers.host = opts.host ?? "test.local";
  return new Request("http://test.local/api/health", { headers });
}

describe("/api/health public path", () => {
  const realDebugToken = process.env.DEBUG_TOKEN;

  it("returns 200 with the minimal public shape to an anonymous cross-origin caller", async () => {
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

  it("does NOT trust a same-origin referer header (audit D12)", async () => {
    process.env.DEBUG_TOKEN = "test-token-secret";
    try {
      const resp = await GET(
        makeReq({ referer: "http://test.local/", host: "test.local" }),
      );
      expect(resp.status).toBe(200);
      const body = (await resp.json()) as Record<string, unknown>;
      // Same-origin Referer alone must NOT promote the response to the
      // detailed shape — only a valid Bearer token does.
      expect("model" in body).toBe(false);
      expect("providers" in body).toBe(false);
      expect("version" in body).toBe(false);
    } finally {
      if (realDebugToken === undefined) delete process.env.DEBUG_TOKEN;
      else process.env.DEBUG_TOKEN = realDebugToken;
    }
  });
});

describe("/api/health privileged path (Bearer token)", () => {
  it("returns detail to a correctly Bearer-authed caller", async () => {
    const realDebugToken = process.env.DEBUG_TOKEN;
    process.env.DEBUG_TOKEN = "test-token-secret";
    try {
      const resp = await GET(makeReq({ auth: "Bearer test-token-secret" }));
      expect(resp.status).toBe(200);
      const body = (await resp.json()) as Record<string, unknown>;
      expect("providers" in body).toBe(true);
      expect(typeof body.model).toBe("string");
      expect(typeof body.version).toBe("string");
    } finally {
      if (realDebugToken === undefined) delete process.env.DEBUG_TOKEN;
      else process.env.DEBUG_TOKEN = realDebugToken;
    }
  });

  it("includes an ISO-8601 timestamp in the detailed shape", async () => {
    const realDebugToken = process.env.DEBUG_TOKEN;
    process.env.DEBUG_TOKEN = "test-token-secret";
    try {
      const before = Date.now();
      const resp = await GET(makeReq({ auth: "Bearer test-token-secret" }));
      const body = (await resp.json()) as { timestamp: string };
      const parsed = Date.parse(body.timestamp);
      expect(Number.isFinite(parsed)).toBe(true);
      expect(Math.abs(parsed - before)).toBeLessThan(5_000);
      expect(body.timestamp).toMatch(/^\d{4}-\d{2}-\d{2}T/);
    } finally {
      if (realDebugToken === undefined) delete process.env.DEBUG_TOKEN;
      else process.env.DEBUG_TOKEN = realDebugToken;
    }
  });

  it("rejects a wrong Bearer token by returning the public shape", async () => {
    const realDebugToken = process.env.DEBUG_TOKEN;
    process.env.DEBUG_TOKEN = "right-token";
    try {
      const resp = await GET(makeReq({ auth: "Bearer wrong-token" }));
      expect(resp.status).toBe(200);
      const body = (await resp.json()) as Record<string, unknown>;
      expect("providers" in body).toBe(false);
    } finally {
      if (realDebugToken === undefined) delete process.env.DEBUG_TOKEN;
      else process.env.DEBUG_TOKEN = realDebugToken;
    }
  });
});
