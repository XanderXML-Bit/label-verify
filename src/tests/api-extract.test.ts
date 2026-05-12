import { describe, expect, it, vi, beforeEach } from "vitest";
import sharp from "sharp";

// ─── Mocks ──────────────────────────────────────────────────────────────────
//
// Mirror api-verify.test.ts: mock the heavy subsystems so this file
// exercises only the route's request/response shape (status codes, MIME
// routing, error envelopes). The extract path has its own logic for
// rejecting bad input and never accepts `declared`, which is what these
// tests cover.

const extractOnlyMock = vi.fn();
vi.mock("@/lib/verify", () => ({
  extractOnly: (...args: unknown[]) => extractOnlyMock(...args),
}));

const fetchUrlImageMock = vi.fn();
vi.mock("@/lib/input-handlers", async () => {
  // eslint-disable-next-line @typescript-eslint/consistent-type-imports -- vitest's documented partial-mock pattern requires `typeof import(...)` here
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
  // eslint-disable-next-line @typescript-eslint/consistent-type-imports -- vitest partial-mock pattern (see above)
  const actual = await vi.importActual<typeof import("@/lib/pdf")>("@/lib/pdf");
  return {
    ...actual,
    extractPdfFirstPage: (...args: unknown[]) =>
      extractPdfFirstPageMock(...args),
  };
});

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

import { POST } from "@/app/api/extract/route";

function fakeExtractResponse() {
  return {
    extracted: {
      brand_name: { value: "Stone IPA", confidence: 0.85 },
      class_type: { value: "India Pale Ale", confidence: 0.9 },
      abv_percent: { value: 6.4, confidence: 0.95 },
      net_contents: {
        value: { value: 12, unit: "fl_oz" },
        confidence: 0.85,
      },
      government_warning: {
        value: {
          raw_text: "GOVERNMENT WARNING:...",
          prefix_text: "GOVERNMENT WARNING:",
          prefix_bbox: { x: 1, y: 1, width: 100, height: 20 },
          prefix_appears_bold: true,
          prefix_appears_caps: true,
        },
        confidence: 0.9,
      },
      producer: {
        value: {
          name: "Stone Brewing Co",
          street: null,
          city: "San Diego",
          state: "CA",
          postal_code: null,
          country: null,
        },
        confidence: 0.8,
      },
      country_of_origin: { value: "USA", confidence: 0.85 },
    },
    imageQuality: "good" as const,
    governmentWarning: {
      status: "pass" as const,
      passes: true,
      subscores: {
        text: { status: "pass" as const, confidence: 1 },
        caps: { status: "pass" as const, confidence: 1 },
        bold: { status: "pass" as const, confidence: 1 },
        size: { status: "pass" as const, confidence: 1 },
      },
    },
    timings: { preprocess: 1, ocr: null, vision: 1, matching: 1, total: 3 },
    modelId: "mock:test",
    modelVersion: "v1",
    modeUsed: "default",
    note: "Application data was not provided.",
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
function nextCallerIp(): string {
  ipCounter += 1;
  return `198.51.101.${ipCounter}`;
}

function buildMultipart(parts: {
  image?: { buffer: Buffer; type: string; name: string };
  url?: string;
  declared?: string;
}): FormData {
  const fd = new FormData();
  if (parts.image) {
    const blob = new Blob([parts.image.buffer as unknown as BlobPart], {
      type: parts.image.type,
    });
    fd.append(
      "image",
      new File([blob], parts.image.name, { type: parts.image.type }),
    );
  }
  if (parts.url !== undefined) fd.append("url", parts.url);
  if (parts.declared !== undefined) fd.append("declared", parts.declared);
  return fd;
}

function makeMultipartReq(form: FormData, ip = nextCallerIp()): Request {
  return new Request("http://test.local/api/extract", {
    method: "POST",
    body: form,
    headers: { "x-forwarded-for": ip },
  });
}

function makeJsonReq(body: unknown, ip = nextCallerIp()): Request {
  return new Request("http://test.local/api/extract", {
    method: "POST",
    body: JSON.stringify(body),
    headers: {
      "content-type": "application/json",
      "x-forwarded-for": ip,
    },
  });
}

beforeEach(() => {
  extractOnlyMock.mockReset();
  fetchUrlImageMock.mockReset();
  extractPdfFirstPageMock.mockReset();
  extractOnlyMock.mockResolvedValue(fakeExtractResponse());
});

describe("/api/extract — multipart image path", () => {
  it("happy path: 200 with extracted-fields shape + note", async () => {
    const form = buildMultipart({
      image: {
        buffer: await tinyJpeg(),
        type: "image/jpeg",
        name: "label.jpg",
      },
    });
    const resp = await POST(makeMultipartReq(form));
    expect(resp.status).toBe(200);
    const body = (await resp.json()) as {
      extracted: unknown;
      note: string;
      governmentWarning: unknown;
    };
    expect(body.note).toMatch(/Application data was not provided/);
    expect(body.extracted).toBeDefined();
    expect(body.governmentWarning).toBeDefined();
    expect(extractOnlyMock).toHaveBeenCalledTimes(1);
  });

  it("does NOT require a 'declared' field (the whole point)", async () => {
    const form = buildMultipart({
      image: { buffer: await tinyJpeg(), type: "image/jpeg", name: "x.jpg" },
    });
    const resp = await POST(makeMultipartReq(form));
    expect(resp.status).toBe(200);
  });

  it("silently ignores a stray 'declared' field if the client sends one", async () => {
    const form = buildMultipart({
      image: { buffer: await tinyJpeg(), type: "image/jpeg", name: "x.jpg" },
      declared: JSON.stringify({ brand_name: "Stone" }),
    });
    const resp = await POST(makeMultipartReq(form));
    expect(resp.status).toBe(200);
  });

  it("415 on an unsupported MIME", async () => {
    const form = buildMultipart({
      image: {
        buffer: Buffer.from("nope"),
        type: "text/plain",
        name: "x.txt",
      },
    });
    const resp = await POST(makeMultipartReq(form));
    expect(resp.status).toBe(415);
  });

  it("400 when neither image nor url is provided", async () => {
    const form = new FormData();
    const resp = await POST(makeMultipartReq(form));
    expect(resp.status).toBe(400);
  });

  it("413 on an oversized image", async () => {
    const big = Buffer.alloc(11 * 1024 * 1024, 0x20);
    const form = buildMultipart({
      image: { buffer: big, type: "image/jpeg", name: "big.jpg" },
    });
    const resp = await POST(makeMultipartReq(form));
    expect(resp.status).toBe(413);
  });

  it("502 when the extractor throws", async () => {
    extractOnlyMock.mockRejectedValueOnce(new Error("vision down"));
    const form = buildMultipart({
      image: { buffer: await tinyJpeg(), type: "image/jpeg", name: "x.jpg" },
    });
    const resp = await POST(makeMultipartReq(form));
    expect(resp.status).toBe(502);
  });

  it("ignores stray mode field and always uses the single production path", async () => {
    const form = buildMultipart({
      image: { buffer: await tinyJpeg(), type: "image/jpeg", name: "x.jpg" },
    });
    form.append("mode", "fast");
    await POST(makeMultipartReq(form));
    expect(extractOnlyMock.mock.calls[0]?.[1]).toEqual({});
  });
});

describe("/api/extract — JSON URL path", () => {
  it("happy path: 200 + extract response on a fetched URL", async () => {
    fetchUrlImageMock.mockResolvedValue({
      buffer: await tinyJpeg(),
      mime: "image/jpeg",
      finalUrl: "https://example.com/label.jpg",
    });
    const resp = await POST(
      makeJsonReq({ url: "https://example.com/label.jpg" }),
    );
    expect(resp.status).toBe(200);
    expect(fetchUrlImageMock).toHaveBeenCalledOnce();
  });

  it("400 on a missing URL", async () => {
    const resp = await POST(makeJsonReq({ url: "" }));
    expect(resp.status).toBe(400);
  });
});

describe("/api/extract — rate limiting", () => {
  it("emits 429 once the per-IP bucket is exhausted", async () => {
    const ip = nextCallerIp();
    // Default RATE_LIMIT_PER_MIN is 60; hammer past it.
    let last: number | undefined;
    for (let i = 0; i < 62; i++) {
      const form = buildMultipart({
        image: {
          buffer: await tinyJpeg(),
          type: "image/jpeg",
          name: `x${i}.jpg`,
        },
      });
      const r = await POST(makeMultipartReq(form, ip));
      last = r.status;
      if (r.status === 429) break;
    }
    expect(last).toBe(429);
  });
});
