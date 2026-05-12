import { describe, expect, it, vi, beforeEach } from "vitest";
import sharp from "sharp";

// ─── Mocks ──────────────────────────────────────────────────────────────────
//
// The route handler imports a few subsystems we don't want to exercise for
// real in unit tests: the vision model (would call an HTTPS endpoint), the
// OCR worker (WASM startup tax), and the URL fetcher (network).
//
// We replace each with a deterministic stub so this test file exercises the
// HTTP-shaped behavior of the route — content-type routing, status codes,
// header passthrough — rather than the verification math (which has its
// own dedicated tests under verify.test.ts).

const verifyLabelMock = vi.fn();
vi.mock("@/lib/verify", () => ({
  verifyLabel: (...args: unknown[]) => verifyLabelMock(...args),
}));

const fetchUrlImageMock = vi.fn();
vi.mock("@/lib/input-handlers", async () => {
  const actual = await vi.importActual<typeof import("@/lib/input-handlers")>(
    "@/lib/input-handlers",
  );
  return {
    ...actual,
    fetchUrlImage: (...args: unknown[]) => fetchUrlImageMock(...args),
  };
});

const extractPdfFirstPageMock = vi.fn();
vi.mock("@/lib/pdf", async () => {
  const actual = await vi.importActual<typeof import("@/lib/pdf")>("@/lib/pdf");
  return {
    ...actual,
    extractPdfFirstPage: (...args: unknown[]) =>
      extractPdfFirstPageMock(...args),
  };
});

// Avoid touching the Tesseract worker. verifyLabel is the mock here so this
// isn't strictly needed, but importing it pulls in a chain of modules.
vi.mock("@/lib/ocr/tesseract", () => ({
  tesseractEngine: {
    id: "tesseract",
    run: async () => ({
      text: "",
      words: [],
      confidence: 0,
      latencyMs: 0,
      engine: "tesseract",
    }),
  },
  warmupTesseract: async () => undefined,
}));

import type { VerifyResponse } from "@/lib/types";

// Import the route AFTER the mocks are wired so its imports resolve to the
// mocked versions. (Vitest hoists vi.mock by default — this is belt-and-
// suspenders for module-load ordering.)
import { POST } from "@/app/api/verify/route";

// ─── Helpers ────────────────────────────────────────────────────────────────

const DECLARED_VALID = {
  brand_name: "Stone's Throw",
  class_type: "Pale Ale",
  class_category: "beer" as const,
  abv_percent: 6.4,
  net_contents: { value: 12, unit: "fl_oz" as const },
  producer: "Stone's Throw Brewing Co.",
  country_of_origin: "USA",
};

function fakeVerifyResponse(): VerifyResponse {
  return {
    verdict: "pass",
    imageQuality: "good",
    fields: {} as VerifyResponse["fields"],
    governmentWarning: {
      status: "pass",
      passes: true,
      subscores: {} as never,
    } as unknown as VerifyResponse["governmentWarning"],
    extracted: {} as VerifyResponse["extracted"],
    timings: { preprocess: 1, ocr: null, vision: 1, matching: 1, total: 3 },
    modelId: "mock:test",
    modelVersion: "v1",
    modeUsed: "default",
    requiresHumanReview: false,
    reviewReasons: [],
  };
}

async function tinyJpeg(): Promise<Buffer> {
  return await sharp({
    create: { width: 50, height: 50, channels: 3, background: "#fff" },
  })
    .jpeg()
    .toBuffer();
}

let ipCounter = 0;
/**
 * Each test gets its own caller IP so the in-memory rate-limit buckets from
 * prior tests don't leak across. (rate-limit.ts keys on `verify:<caller>`.)
 */
function nextCallerIp(): string {
  ipCounter += 1;
  return `198.51.100.${ipCounter}`;
}

function buildMultipart(parts: {
  image?: { buffer: Buffer; type: string; name: string };
  declared?: string;
  url?: string;
}): FormData {
  const fd = new FormData();
  if (parts.image) {
    // Construct via Blob → File so the file's bytes round-trip correctly
    // regardless of Node Buffer<ArrayBufferLike> vs lib.dom's BlobPart
    // narrowing on ArrayBuffer. Casting the Buffer to BlobPart at the call
    // site is safe — Buffer is a Uint8Array subclass and Blob accepts it
    // at runtime; only the type signature is overly strict.
    const blob = new Blob([parts.image.buffer as unknown as BlobPart], {
      type: parts.image.type,
    });
    fd.append(
      "image",
      new File([blob], parts.image.name, {
        type: parts.image.type,
      }),
    );
  }
  if (parts.declared !== undefined) {
    fd.append("declared", parts.declared);
  }
  if (parts.url !== undefined) {
    fd.append("url", parts.url);
  }
  return fd;
}

function makeMultipartReq(form: FormData, ip = nextCallerIp()): Request {
  return new Request("http://test.local/api/verify", {
    method: "POST",
    body: form,
    headers: { "x-forwarded-for": ip },
  });
}

function makeJsonReq(body: unknown, ip = nextCallerIp()): Request {
  return new Request("http://test.local/api/verify", {
    method: "POST",
    body: JSON.stringify(body),
    headers: {
      "content-type": "application/json",
      "x-forwarded-for": ip,
    },
  });
}

// ─── Tests ──────────────────────────────────────────────────────────────────

beforeEach(() => {
  verifyLabelMock.mockReset();
  fetchUrlImageMock.mockReset();
  extractPdfFirstPageMock.mockReset();
  verifyLabelMock.mockResolvedValue(fakeVerifyResponse());
});

describe("/api/verify — multipart image path", () => {
  it("happy path: returns 200 + VerifyResponse shape", async () => {
    const form = buildMultipart({
      image: { buffer: await tinyJpeg(), type: "image/jpeg", name: "a.jpg" },
      declared: JSON.stringify(DECLARED_VALID),
    });
    const resp = await POST(makeMultipartReq(form));
    expect(resp.status).toBe(200);
    const body = (await resp.json()) as VerifyResponse;
    expect(body.verdict).toBe("pass");
    expect(body.modelId).toBe("mock:test");
    expect(verifyLabelMock).toHaveBeenCalledTimes(1);
  });

  it("includes X-RateLimit-Remaining on a successful response", async () => {
    const form = buildMultipart({
      image: { buffer: await tinyJpeg(), type: "image/jpeg", name: "a.jpg" },
      declared: JSON.stringify(DECLARED_VALID),
    });
    const resp = await POST(makeMultipartReq(form));
    expect(resp.status).toBe(200);
    expect(resp.headers.get("X-RateLimit-Remaining")).not.toBeNull();
    expect(Number(resp.headers.get("X-RateLimit-Remaining"))).toBeGreaterThanOrEqual(0);
  });


  it("ignores stray multipart mode field and always uses the single production path", async () => {
    const form = buildMultipart({
      image: { buffer: await tinyJpeg(), type: "image/jpeg", name: "a.jpg" },
      declared: JSON.stringify(DECLARED_VALID),
    });
    form.append("mode", "smart");
    const resp = await POST(makeMultipartReq(form));
    expect(resp.status).toBe(200);
    const options = verifyLabelMock.mock.calls[0]?.[2] as Record<string, unknown>;
    expect(options).not.toHaveProperty("modelMode");
  });

  it("415 on an unsupported MIME (e.g. text/plain)", async () => {
    const form = buildMultipart({
      image: { buffer: Buffer.from("not an image"), type: "text/plain", name: "x.txt" },
      declared: JSON.stringify(DECLARED_VALID),
    });
    const resp = await POST(makeMultipartReq(form));
    expect(resp.status).toBe(415);
  });

  it("413 when an oversized image is submitted", async () => {
    // 11 MB > the 10 MB upload ceiling.
    const big = Buffer.alloc(11 * 1024 * 1024, 0x20);
    const form = buildMultipart({
      image: { buffer: big, type: "image/jpeg", name: "huge.jpg" },
      declared: JSON.stringify(DECLARED_VALID),
    });
    const resp = await POST(makeMultipartReq(form));
    expect(resp.status).toBe(413);
  });

  it("400 when declared is missing entirely", async () => {
    const form = buildMultipart({
      image: { buffer: await tinyJpeg(), type: "image/jpeg", name: "a.jpg" },
    });
    const resp = await POST(makeMultipartReq(form));
    expect(resp.status).toBe(400);
    const body = (await resp.json()) as { error: string };
    expect(body.error).toMatch(/declared/i);
  });

  it("400 when declared is malformed JSON", async () => {
    const form = buildMultipart({
      image: { buffer: await tinyJpeg(), type: "image/jpeg", name: "a.jpg" },
      declared: "{not json",
    });
    const resp = await POST(makeMultipartReq(form));
    expect(resp.status).toBe(400);
    const body = (await resp.json()) as { error: string };
    expect(body.error).toMatch(/not valid JSON/i);
  });

  it("400 + issues[] when declared fails schema validation", async () => {
    const form = buildMultipart({
      image: { buffer: await tinyJpeg(), type: "image/jpeg", name: "a.jpg" },
      declared: JSON.stringify({ brand_name: "" /* required missing fields */ }),
    });
    const resp = await POST(makeMultipartReq(form));
    expect(resp.status).toBe(400);
    const body = (await resp.json()) as { error: string; issues: unknown[] };
    expect(body.error).toMatch(/schema/i);
    expect(Array.isArray(body.issues)).toBe(true);
    expect(body.issues.length).toBeGreaterThan(0);
  });

  it("400 when no image and no url field is provided", async () => {
    const form = buildMultipart({
      declared: JSON.stringify(DECLARED_VALID),
    });
    const resp = await POST(makeMultipartReq(form));
    expect(resp.status).toBe(400);
    const body = (await resp.json()) as { error: string };
    expect(body.error).toMatch(/image|url/i);
  });
});

describe("/api/verify — PDF path", () => {
  it("routes a PDF upload through extractPdfFirstPage before verifying", async () => {
    extractPdfFirstPageMock.mockResolvedValueOnce({
      pngBuffer: Buffer.from([0x89, 0x50, 0x4e, 0x47]),
      pageCount: 1,
    });
    const form = buildMultipart({
      image: {
        buffer: Buffer.from("%PDF-1.4\n%fake\n"),
        type: "application/pdf",
        name: "label.pdf",
      },
      declared: JSON.stringify(DECLARED_VALID),
    });
    const resp = await POST(makeMultipartReq(form));
    expect(resp.status).toBe(200);
    expect(extractPdfFirstPageMock).toHaveBeenCalledTimes(1);
    expect(verifyLabelMock).toHaveBeenCalledTimes(1);
  });
});

describe("/api/verify — JSON {url, declared}", () => {
  it("fetches the URL and verifies on the returned buffer", async () => {
    fetchUrlImageMock.mockResolvedValueOnce({
      buffer: Buffer.from([0x89, 0x50]),
      mime: "image/png",
      finalUrl: "https://example.com/x.png",
    });
    const resp = await POST(
      makeJsonReq({
        url: "https://example.com/x.png",
        declared: DECLARED_VALID,
      }),
    );
    expect(resp.status).toBe(200);
    expect(fetchUrlImageMock).toHaveBeenCalledWith("https://example.com/x.png");
    expect(verifyLabelMock).toHaveBeenCalledTimes(1);
  });

  it("400 when url is missing from a JSON body", async () => {
    const resp = await POST(makeJsonReq({ declared: DECLARED_VALID }));
    expect(resp.status).toBe(400);
    const body = (await resp.json()) as { error: string };
    expect(body.error).toMatch(/url/i);
  });

  it("400 when the JSON body is not parseable JSON", async () => {
    const req = new Request("http://test.local/api/verify", {
      method: "POST",
      body: "{not json",
      headers: {
        "content-type": "application/json",
        "x-forwarded-for": nextCallerIp(),
      },
    });
    const resp = await POST(req);
    expect(resp.status).toBe(400);
  });
});


  it("ignores stray JSON mode field and always uses the single production path", async () => {
    fetchUrlImageMock.mockResolvedValue({
      buffer: await tinyJpeg(),
      mime: "image/jpeg",
      finalUrl: "https://example.com/label.jpg",
    });
    const resp = await POST(
      makeJsonReq({
        url: "https://example.com/label.jpg",
        declared: DECLARED_VALID,
        mode: "local",
      }),
    );
    expect(resp.status).toBe(200);
    const options = verifyLabelMock.mock.calls[0]?.[2] as Record<string, unknown>;
    expect(options).not.toHaveProperty("modelMode");
  });

describe("/api/verify — rate limiting", () => {
  it("429 + Retry-After header when the per-minute budget is exhausted", async () => {
    // Drive the same caller key past the limit. RATE_LIMIT_PER_MIN defaults
    // to 60; using a fresh IP each test means we usually start with a full
    // bucket. Loop just past 60 to trip the limit deterministically.
    const ip = nextCallerIp();
    let lastResp: Response | null = null;
    for (let i = 0; i < 65; i++) {
      const form = buildMultipart({
        image: { buffer: await tinyJpeg(), type: "image/jpeg", name: "a.jpg" },
        declared: JSON.stringify(DECLARED_VALID),
      });
      lastResp = await POST(makeMultipartReq(form, ip));
      if (lastResp.status === 429) break;
    }
    expect(lastResp).not.toBeNull();
    expect(lastResp!.status).toBe(429);
    expect(lastResp!.headers.get("Retry-After")).not.toBeNull();
    expect(Number(lastResp!.headers.get("Retry-After"))).toBeGreaterThan(0);
    expect(lastResp!.headers.get("X-RateLimit-Remaining")).toBe("0");
  });
});
