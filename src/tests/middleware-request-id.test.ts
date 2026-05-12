import { describe, expect, it } from "vitest";

// Direct unit test for the middleware function. NextRequest is
// constructible from a Web Request in the Next.js test runtime, but to
// avoid pulling in the full Next runtime here we just dispatch the same
// logic the middleware encapsulates: read inbound x-request-id, sanitise,
// fall back to crypto.randomUUID.

import { middleware } from "@/middleware";
import { NextRequest } from "next/server";

function makeReq(headers: Record<string, string> = {}): NextRequest {
  return new NextRequest("http://test.local/api/verify", { headers });
}

describe("X-Request-Id middleware (REMAINING-IMPROVEMENTS R2)", () => {
  it("generates a UUID when the client sends nothing", () => {
    const res = middleware(makeReq());
    const id = res.headers.get("X-Request-Id");
    expect(id).toBeTruthy();
    // UUID v4 shape, loose match
    expect(id).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i);
  });

  it("honours a valid inbound X-Request-Id", () => {
    const res = middleware(makeReq({ "x-request-id": "abc-123_XYZ" }));
    expect(res.headers.get("X-Request-Id")).toBe("abc-123_XYZ");
  });

  it("ignores an inbound id with disallowed characters and generates a UUID instead", () => {
    // The Web Headers spec already blocks CR/LF in header values at
    // parse time, so we test with a value that's accepted by Headers
    // but disallowed by our allowlist regex: spaces and angle-brackets
    // (a classic log-substrate / shell-injection vector).
    const res = middleware(makeReq({ "x-request-id": "evil <script>" }));
    const id = res.headers.get("X-Request-Id");
    expect(id).not.toBe("evil <script>");
    expect(id).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i);
  });

  it("ignores an inbound id over 128 chars", () => {
    const big = "a".repeat(200);
    const res = middleware(makeReq({ "x-request-id": big }));
    const id = res.headers.get("X-Request-Id");
    expect(id).not.toBe(big);
    expect(id?.length).toBeLessThanOrEqual(128);
  });
});
