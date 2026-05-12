import { describe, expect, it } from "vitest";
import { callerKey, rateLimit } from "@/lib/rate-limit";

describe("rateLimit", () => {
  it("allows the first request and decrements remaining", () => {
    const r = rateLimit("test:fresh-1", { perMinute: 5 });
    expect(r.allowed).toBe(true);
    expect(r.remaining).toBeGreaterThanOrEqual(3);
  });

  it("blocks once the burst is exhausted", () => {
    const key = "test:burst";
    for (let i = 0; i < 3; i++) {
      const r = rateLimit(key, { perMinute: 60, burst: 3 });
      expect(r.allowed).toBe(true);
    }
    const blocked = rateLimit(key, { perMinute: 60, burst: 3 });
    expect(blocked.allowed).toBe(false);
    expect(blocked.resetSeconds).toBeGreaterThan(0);
  });
});

describe("callerKey", () => {
  it("prefers x-forwarded-for first hop", () => {
    const h = new Headers();
    h.set("x-forwarded-for", "203.0.113.10, 10.0.0.1");
    expect(callerKey(h)).toBe("203.0.113.10");
  });
  it("falls back to x-real-ip", () => {
    const h = new Headers();
    h.set("x-real-ip", "198.51.100.7");
    expect(callerKey(h)).toBe("198.51.100.7");
  });
  it("returns anonymous when no headers", () => {
    expect(callerKey(new Headers())).toBe("anonymous");
  });
});
