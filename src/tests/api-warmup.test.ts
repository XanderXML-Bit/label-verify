// Wave-32 audit fix (Sub-agent B G10): /api/warmup had 0 % coverage on the
// branch where it actually exposes a public route. The route runs both a
// Tesseract WASM warmup (with an 8 s timeout race) and an in-process
// Gemini SDK warmup (cheap; no network call). All three end states are
// reachable: tesseract={ok|timeout|failed} × gemini={ok|missing-key|failed}.

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// Hoist mocks so the route's top-level imports resolve to our stubs.
vi.mock("@/lib/ocr/tesseract", () => ({
  warmupTesseract: vi.fn(),
}));

describe("/api/warmup", () => {
  const originalGoogleKey = process.env.GOOGLE_API_KEY;

  beforeEach(() => {
    vi.resetModules();
  });

  afterEach(() => {
    if (originalGoogleKey === undefined) delete process.env.GOOGLE_API_KEY;
    else process.env.GOOGLE_API_KEY = originalGoogleKey;
    vi.clearAllMocks();
  });

  it("returns ok=true and warmupMs on a fully-successful warmup", async () => {
    process.env.GOOGLE_API_KEY = "test-key";
    const { warmupTesseract } = await import("@/lib/ocr/tesseract");
    (warmupTesseract as ReturnType<typeof vi.fn>).mockResolvedValue(undefined);
    const { GET } = await import("@/app/api/warmup/route");
    const res = await GET();
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.ok).toBe(true);
    expect(body.tesseract).toBe("ok");
    expect(body.gemini).toBe("ok");
    expect(typeof body.warmupMs).toBe("number");
    expect(body.warmupMs).toBeGreaterThanOrEqual(0);
  });

  it("reports gemini=missing-key when GOOGLE_API_KEY is unset", async () => {
    delete process.env.GOOGLE_API_KEY;
    const { warmupTesseract } = await import("@/lib/ocr/tesseract");
    (warmupTesseract as ReturnType<typeof vi.fn>).mockResolvedValue(undefined);
    const { GET } = await import("@/app/api/warmup/route");
    const res = await GET();
    const body = await res.json();
    expect(body.ok).toBe(true);
    expect(body.gemini).toBe("missing-key");
    expect(body.tesseract).toBe("ok");
  });

  it("reports tesseract=failed when warmupTesseract rejects synchronously", async () => {
    process.env.GOOGLE_API_KEY = "test-key";
    const { warmupTesseract } = await import("@/lib/ocr/tesseract");
    (warmupTesseract as ReturnType<typeof vi.fn>).mockRejectedValue(
      new Error("tessdata fetch failed"),
    );
    const { GET } = await import("@/app/api/warmup/route");
    const res = await GET();
    const body = await res.json();
    expect(body.ok).toBe(true);
    expect(body.tesseract).toBe("failed");
  });

  it("never throws — outer try/catch + per-branch swallow keep the route stable", async () => {
    process.env.GOOGLE_API_KEY = "test-key";
    const { warmupTesseract } = await import("@/lib/ocr/tesseract");
    // Reject with an Error-like that's not an instance of Error to exercise the
    // `(err as Error).message ?? ""` branch.
    (warmupTesseract as ReturnType<typeof vi.fn>).mockImplementation(() =>
      Promise.reject({ message: "weird non-Error rejection" }),
    );
    const { GET } = await import("@/app/api/warmup/route");
    await expect(GET()).resolves.toBeDefined();
  });
});
