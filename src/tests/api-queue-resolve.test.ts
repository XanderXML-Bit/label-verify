// Wave-33 coverage push: /api/queue/[id]/resolve had 0% coverage on main.
// All 6 status-mapping branches exercised here so a future refactor can't
// silently break the human-resolve flow.

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("@/lib/review-queue", () => ({
  markResolved: vi.fn(),
}));

vi.mock("@/lib/debug-token", () => ({
  checkDebugBearer: vi.fn((auth: string, token: string) => {
    const expected = `Bearer ${token}`;
    return auth === expected;
  }),
}));

describe("POST /api/queue/[id]/resolve", () => {
  const originalToken = process.env.DEBUG_TOKEN;

  beforeEach(() => {
    vi.resetModules();
  });

  afterEach(() => {
    if (originalToken === undefined) delete process.env.DEBUG_TOKEN;
    else process.env.DEBUG_TOKEN = originalToken;
    vi.clearAllMocks();
  });

  async function callPost(body: unknown, opts: { id?: string; auth?: string } = {}) {
    const { POST } = await import("@/app/api/queue/[id]/resolve/route");
    const req = new Request("http://localhost/api/queue/abc/resolve", {
      method: "POST",
      headers: {
        "content-type": "application/json",
        ...(opts.auth ? { authorization: opts.auth } : {}),
      },
      body: typeof body === "string" ? body : JSON.stringify(body),
    });
    return POST(req, { params: Promise.resolve({ id: opts.id ?? "abc" }) });
  }

  it("returns 404 when DEBUG_TOKEN is unset (route is hidden)", async () => {
    delete process.env.DEBUG_TOKEN;
    const res = await callPost({ verdict: "pass", resolvedBy: "alice" });
    expect(res.status).toBe(404);
  });

  it("returns 401 on missing Authorization header", async () => {
    process.env.DEBUG_TOKEN = "secret";
    const res = await callPost({ verdict: "pass", resolvedBy: "alice" });
    expect(res.status).toBe(401);
  });

  it("returns 401 on wrong bearer", async () => {
    process.env.DEBUG_TOKEN = "secret";
    const res = await callPost(
      { verdict: "pass", resolvedBy: "alice" },
      { auth: "Bearer WRONG" },
    );
    expect(res.status).toBe(401);
  });

  it("returns 400 on invalid JSON body", async () => {
    process.env.DEBUG_TOKEN = "secret";
    const res = await callPost("not valid json", { auth: "Bearer secret" });
    expect(res.status).toBe(400);
    const body = await res.json();
    expect(body.error).toMatch(/JSON/);
  });

  it("returns 400 on missing verdict", async () => {
    process.env.DEBUG_TOKEN = "secret";
    const res = await callPost(
      { resolvedBy: "alice" },
      { auth: "Bearer secret" },
    );
    expect(res.status).toBe(400);
    const body = await res.json();
    expect(body.error).toMatch(/verdict/i);
  });

  it("returns 400 on invalid verdict value", async () => {
    process.env.DEBUG_TOKEN = "secret";
    const res = await callPost(
      { verdict: "maybe", resolvedBy: "alice" },
      { auth: "Bearer secret" },
    );
    expect(res.status).toBe(400);
  });

  it("returns 400 on missing resolvedBy", async () => {
    process.env.DEBUG_TOKEN = "secret";
    const res = await callPost(
      { verdict: "pass", resolvedBy: "" },
      { auth: "Bearer secret" },
    );
    expect(res.status).toBe(400);
    const body = await res.json();
    expect(body.error).toMatch(/resolvedBy/);
  });

  it("returns 404 when markResolved reports the item is not found", async () => {
    process.env.DEBUG_TOKEN = "secret";
    const { markResolved } = await import("@/lib/review-queue");
    (markResolved as ReturnType<typeof vi.fn>).mockReturnValue(false);
    const res = await callPost(
      { verdict: "fail", resolvedBy: "alice" },
      { auth: "Bearer secret" },
    );
    expect(res.status).toBe(404);
  });

  it("returns 200 with ok:true and forwards notes when present", async () => {
    process.env.DEBUG_TOKEN = "secret";
    const { markResolved } = await import("@/lib/review-queue");
    (markResolved as ReturnType<typeof vi.fn>).mockReturnValue(true);
    const res = await callPost(
      { verdict: "pass", resolvedBy: "alice", notes: "OK after re-photograph" },
      { auth: "Bearer secret" },
    );
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.ok).toBe(true);
    expect(markResolved).toHaveBeenCalledWith(
      "abc",
      expect.objectContaining({
        verdict: "pass",
        resolvedBy: "alice",
        notes: "OK after re-photograph",
      }),
    );
  });

  it("returns 200 and omits notes when blank/missing", async () => {
    process.env.DEBUG_TOKEN = "secret";
    const { markResolved } = await import("@/lib/review-queue");
    (markResolved as ReturnType<typeof vi.fn>).mockReturnValue(true);
    await callPost(
      { verdict: "pass", resolvedBy: "alice" },
      { auth: "Bearer secret" },
    );
    expect(markResolved).toHaveBeenCalledWith(
      "abc",
      expect.not.objectContaining({ notes: expect.anything() }),
    );
  });
});
