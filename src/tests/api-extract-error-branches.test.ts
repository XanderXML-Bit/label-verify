// Wave-35g (follow-on) — coverage on the still-uncovered branches of
// /api/extract.
//
// The existing api-extract.test.ts pins the happy paths + bad-MIME /
// oversized / missing-input / rate-limit. This file pins the
// remaining error branches: JSON-body URL-fetch failures, multipart
// `url` field path, PDF processing branches, and the bad-JSON body
// guard.

import { describe, expect, it, vi, beforeEach } from "vitest";
import sharp from "sharp";

const extractOnlyMock = vi.fn();
vi.mock("@/lib/verify", () => ({
  extractOnly: (...args: unknown[]) => extractOnlyMock(...args),
}));

const fetchUrlImageMock = vi.fn();
vi.mock("@/lib/input-handlers", async () => {
  // eslint-disable-next-line @typescript-eslint/consistent-type-imports -- vitest's documented partial-mock pattern
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
  // eslint-disable-next-line @typescript-eslint/consistent-type-imports -- vitest partial-mock pattern
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
import { UrlFetchError } from "@/lib/input-handlers";
import { PdfExtractError } from "@/lib/pdf";

function fakeExtractResponse() {
  return {
    extracted: {} as Record<string, unknown>,
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
    modelId: "mock",
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

let ipCounter = 7_000;
function nextCallerIp(): string {
  ipCounter += 1;
  return `198.51.102.${ipCounter % 250}`;
}

function jsonReq(body: unknown | string): Request {
  return new Request("http://test.local/api/extract", {
    method: "POST",
    body: typeof body === "string" ? body : JSON.stringify(body),
    headers: {
      "content-type": "application/json",
      "x-forwarded-for": nextCallerIp(),
    },
  });
}

function multipartReq(parts: {
  image?: { buffer: Buffer; type: string; name: string };
  url?: string;
}): Request {
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
  return new Request("http://test.local/api/extract", {
    method: "POST",
    body: fd,
    headers: { "x-forwarded-for": nextCallerIp() },
  });
}

beforeEach(() => {
  extractOnlyMock.mockReset();
  fetchUrlImageMock.mockReset();
  extractPdfFirstPageMock.mockReset();
  extractOnlyMock.mockResolvedValue(fakeExtractResponse());
});

describe("/api/extract — JSON body error branches", () => {
  it("400 when JSON body is not parseable", async () => {
    const resp = await POST(jsonReq("{not json"));
    expect(resp.status).toBe(400);
    const body = (await resp.json()) as { error: string };
    expect(body.error).toMatch(/not valid JSON/i);
  });

  it("propagates UrlFetchError status on JSON path (e.g. 415)", async () => {
    fetchUrlImageMock.mockRejectedValueOnce(
      new UrlFetchError("Remote MIME is text/html.", 415),
    );
    const resp = await POST(jsonReq({ url: "https://x.example/page.html" }));
    expect(resp.status).toBe(415);
    const body = (await resp.json()) as { error: string };
    expect(body.error).toMatch(/MIME/i);
  });

  it("502 on generic fetch failure (non-UrlFetchError)", async () => {
    fetchUrlImageMock.mockRejectedValueOnce(new Error("ECONNRESET"));
    const resp = await POST(jsonReq({ url: "https://x.example/x.jpg" }));
    expect(resp.status).toBe(502);
    const body = (await resp.json()) as { error: string };
    expect(body.error).toMatch(/URL fetch failed.*ECONNRESET/);
  });
});

describe("/api/extract — multipart `url` field path", () => {
  it("happy path: multipart with url field fetches and extracts", async () => {
    fetchUrlImageMock.mockResolvedValueOnce({
      buffer: await tinyJpeg(),
      mime: "image/jpeg",
      finalUrl: "https://x.example/label.jpg",
    });
    const resp = await POST(multipartReq({ url: "https://x.example/label.jpg" }));
    expect(resp.status).toBe(200);
    expect(fetchUrlImageMock).toHaveBeenCalledTimes(1);
    expect(extractOnlyMock).toHaveBeenCalledTimes(1);
  });

  it("propagates UrlFetchError status on multipart-url path", async () => {
    fetchUrlImageMock.mockRejectedValueOnce(
      new UrlFetchError("Image too large.", 413),
    );
    const resp = await POST(multipartReq({ url: "https://x.example/huge.jpg" }));
    expect(resp.status).toBe(413);
  });

  it("502 on generic fetch failure via multipart-url path", async () => {
    fetchUrlImageMock.mockRejectedValueOnce(new Error("dns timeout"));
    const resp = await POST(multipartReq({ url: "https://x.example/x.jpg" }));
    expect(resp.status).toBe(502);
    const body = (await resp.json()) as { error: string };
    expect(body.error).toMatch(/dns timeout/);
  });
});

describe("/api/extract — PDF path", () => {
  it("happy path: routes PDF upload through extractPdfFirstPage", async () => {
    extractPdfFirstPageMock.mockResolvedValueOnce({
      pngBuffer: Buffer.from([0x89, 0x50, 0x4e, 0x47]),
      pageCount: 1,
    });
    const fd = new FormData();
    const pdfBlob = new Blob([Buffer.from("%PDF-1.4\n") as unknown as BlobPart], {
      type: "application/pdf",
    });
    fd.append("image", new File([pdfBlob], "label.pdf", { type: "application/pdf" }));
    const req = new Request("http://test.local/api/extract", {
      method: "POST",
      body: fd,
      headers: { "x-forwarded-for": nextCallerIp() },
    });
    const resp = await POST(req);
    expect(resp.status).toBe(200);
    expect(extractPdfFirstPageMock).toHaveBeenCalledTimes(1);
    expect(extractOnlyMock).toHaveBeenCalledTimes(1);
  });

  it("413 when PdfExtractError has code='too-large'", async () => {
    extractPdfFirstPageMock.mockRejectedValueOnce(
      new PdfExtractError("too-large", "PDF too large"),
    );
    const fd = new FormData();
    const pdfBlob = new Blob([Buffer.from("%PDF") as unknown as BlobPart], {
      type: "application/pdf",
    });
    fd.append("image", new File([pdfBlob], "x.pdf", { type: "application/pdf" }));
    const req = new Request("http://test.local/api/extract", {
      method: "POST",
      body: fd,
      headers: { "x-forwarded-for": nextCallerIp() },
    });
    const resp = await POST(req);
    expect(resp.status).toBe(413);
    const body = (await resp.json()) as { error: string; code: string };
    expect(body.code).toBe("too-large");
  });

  it("400 when PdfExtractError has code='encrypted' (not too-large)", async () => {
    extractPdfFirstPageMock.mockRejectedValueOnce(
      new PdfExtractError("encrypted", "PDF is encrypted"),
    );
    const fd = new FormData();
    const pdfBlob = new Blob([Buffer.from("%PDF") as unknown as BlobPart], {
      type: "application/pdf",
    });
    fd.append("image", new File([pdfBlob], "x.pdf", { type: "application/pdf" }));
    const req = new Request("http://test.local/api/extract", {
      method: "POST",
      body: fd,
      headers: { "x-forwarded-for": nextCallerIp() },
    });
    const resp = await POST(req);
    expect(resp.status).toBe(400);
    const body = (await resp.json()) as { code: string };
    expect(body.code).toBe("encrypted");
  });

  it("rethrows non-PdfExtractError so it surfaces as a 500", async () => {
    extractPdfFirstPageMock.mockRejectedValueOnce(new Error("disk full"));
    const fd = new FormData();
    const pdfBlob = new Blob([Buffer.from("%PDF") as unknown as BlobPart], {
      type: "application/pdf",
    });
    fd.append("image", new File([pdfBlob], "x.pdf", { type: "application/pdf" }));
    const req = new Request("http://test.local/api/extract", {
      method: "POST",
      body: fd,
      headers: { "x-forwarded-for": nextCallerIp() },
    });
    // The route re-throws — Next.js maps an unhandled throw to a 500.
    // In the test environment, await POST(...) surfaces the error.
    await expect(POST(req)).rejects.toThrow(/disk full/);
  });
});

describe("/api/extract — content-type fallback", () => {
  it("400 when body is empty multipart and JSON content-type wasn't set", async () => {
    const req = new Request("http://test.local/api/extract", {
      method: "POST",
      body: "",
      headers: { "x-forwarded-for": nextCallerIp() },
    });
    const resp = await POST(req);
    expect(resp.status).toBe(400);
    const body = (await resp.json()) as { error: string };
    expect(body.error).toMatch(/multipart|JSON/i);
  });
});
