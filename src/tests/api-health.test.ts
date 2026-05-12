import { describe, expect, it } from "vitest";
import { GET } from "@/app/api/health/route";

describe("/api/health", () => {
  it("returns 200 with ok:true, service identifier, model, and version", async () => {
    const resp = await GET();
    expect(resp.status).toBe(200);
    const body = (await resp.json()) as Record<string, unknown>;
    expect(body.ok).toBe(true);
    expect(body.service).toBe("label-verify");
    expect(typeof body.model).toBe("string");
    expect((body.model as string).length).toBeGreaterThan(0);
    expect(typeof body.version).toBe("string");
    expect((body.version as string).length).toBeGreaterThan(0);
  });

  it("includes an ISO-8601 timestamp", async () => {
    const before = Date.now();
    const resp = await GET();
    const body = (await resp.json()) as { timestamp: string };
    const parsed = Date.parse(body.timestamp);
    expect(Number.isFinite(parsed)).toBe(true);
    // Generous window — the request takes < 1s, allow 5s in either direction.
    expect(Math.abs(parsed - before)).toBeLessThan(5_000);
    expect(body.timestamp).toMatch(/^\d{4}-\d{2}-\d{2}T/);
  });
});
