// Wave-35g — coverage on the still-uncovered error branches of
// /api/verify/route.ts.
//
// The existing api-verify.test.ts pins the happy paths plus the
// declared-validation 400s. This file pins the remaining error
// branches that a regression could easily break unnoticed:
//
//   1. JSON body URL-fetch failures (UrlFetchError vs generic 502)
//   2. Multipart `url` field path (parallel to JSON {url, declared})
//   3. PDF processing errors (encrypted / empty / render-failed)
//   4. runVerify catch: AbortError → 504; other errors → 500
//   5. Review-queue enqueue when requiresHumanReview is true (the
//      route silently swallows queue errors — verify it returns 200)
//
// We mock @/lib/verify, @/lib/input-handlers (fetchUrlImage),
// @/lib/pdf (extractPdfFirstPage), and @/lib/ocr/tesseract so the
// route's HTTP shape is the thing under test, not its dependencies.

import { describe, expect, it, vi, beforeEach } from "vitest";
import sharp from "sharp";

const verifyLabelMock = vi.fn();
vi.mock("@/lib/verify", () => ({
  verifyLabel: (...args: unknown[]) => verifyLabelMock(...args),
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

import type { VerifyResponse } from "@/lib/types";
import { POST } from "@/app/api/verify/route";
import { UrlFetchError } from "@/lib/input-handlers";
import { PdfExtractError } from "@/lib/pdf";

const DECLARED_VALID = {
  brand_name: "Stone's Throw",
  class_type: "Pale Ale",
  class_category: "beer" as const,
  abv_percent: 6.4,
  net_contents: { value: 12, unit: "fl_oz" as const },
  producer: "Stone's Throw Brewing Co.",
  country_of_origin: "USA",
};

function fakeVerifyResponse(
  overrides: Partial<VerifyResponse> = {},
): VerifyResponse {
  return {
    verdict: "pass",
    imageQuality: "good",
    fields: {} as VerifyResponse["fields"],
    governmentWarning: {} as VerifyResponse["governmentWarning"],
    extracted: {} as VerifyResponse["extracted"],
    timings: { preprocess: 1, ocr: null, vision: 1, matching: 1, total: 3 },
    modelId: "mock:test",
    modelVersion: "v1",
    modeUsed: "default",
    requiresHumanReview: false,
    reviewReasons: [],
    ...overrides,
  };
}

async function tinyJpeg(): Promise<Buffer> {
  return await sharp({
    create: { width: 50, height: 50, channels: 3, background: "#fff" },
  })
    .jpeg()
    .toBuffer();
}

let ipCounter = 5_000; // distinct range from api-verify.test.ts
function nextCallerIp(): string {
  ipCounter += 1;
  return `198.51.101.${ipCounter % 250}`;
}

function multipartReq(parts: {
  image?: { buffer: Buffer; type: string; name: string };
  declared?: string;
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
  if (parts.declared !== undefined) fd.append("declared", parts.declared);
  if (parts.url !== undefined) fd.append("url", parts.url);
  return new Request("http://test.local/api/verify", {
    method: "POST",
    body: fd,
    headers: { "x-forwarded-for": nextCallerIp() },
  });
}

function jsonReq(body: unknown): Request {
  return new Request("http://test.local/api/verify", {
    method: "POST",
    body: JSON.stringify(body),
    headers: {
      "content-type": "application/json",
      "x-forwarded-for": nextCallerIp(),
    },
  });
}

beforeEach(() => {
  verifyLabelMock.mockReset();
  fetchUrlImageMock.mockReset();
  extractPdfFirstPageMock.mockReset();
  verifyLabelMock.mockResolvedValue(fakeVerifyResponse());
});

describe("/api/verify — JSON {url, declared} error branches", () => {
  it("propagates UrlFetchError's status (e.g. 415 unsupported MIME)", async () => {
    fetchUrlImageMock.mockRejectedValueOnce(
      new UrlFetchError("Remote MIME is text/html, not an image.", 415),
    );
    const resp = await POST(
      jsonReq({ url: "https://x.example/index.html", declared: DECLARED_VALID }),
    );
    expect(resp.status).toBe(415);
    const body = (await resp.json()) as { error: string };
    expect(body.error).toMatch(/MIME/i);
  });

  it("converts a non-UrlFetchError fetch failure into a 502", async () => {
    fetchUrlImageMock.mockRejectedValueOnce(new Error("ENOTFOUND"));
    const resp = await POST(
      jsonReq({ url: "https://nope.example/x.jpg", declared: DECLARED_VALID }),
    );
    expect(resp.status).toBe(502);
    const body = (await resp.json()) as { error: string };
    expect(body.error).toMatch(/URL fetch failed.*ENOTFOUND/);
  });

  it("400 when declared in a JSON body fails schema validation", async () => {
    const resp = await POST(
      jsonReq({ url: "https://x.example/x.jpg", declared: { brand_name: "" } }),
    );
    expect(resp.status).toBe(400);
    const body = (await resp.json()) as { error: string };
    expect(body.error).toMatch(/schema/i);
  });
});

describe("/api/verify — multipart `url` field path", () => {
  it("happy path: multipart with url field fetches and verifies", async () => {
    fetchUrlImageMock.mockResolvedValueOnce({
      buffer: await tinyJpeg(),
      mime: "image/jpeg",
      finalUrl: "https://x.example/label.jpg",
    });
    const resp = await POST(
      multipartReq({
        url: "https://x.example/label.jpg",
        declared: JSON.stringify(DECLARED_VALID),
      }),
    );
    expect(resp.status).toBe(200);
    expect(fetchUrlImageMock).toHaveBeenCalledTimes(1);
    expect(verifyLabelMock).toHaveBeenCalledTimes(1);
  });

  it("400 when multipart url field is provided without declared", async () => {
    const resp = await POST(
      multipartReq({ url: "https://x.example/label.jpg" }),
    );
    expect(resp.status).toBe(400);
    const body = (await resp.json()) as { error: string };
    expect(body.error).toMatch(/declared/i);
  });

  it("400 when multipart url field is provided with malformed declared JSON", async () => {
    const resp = await POST(
      multipartReq({ url: "https://x.example/x.jpg", declared: "{nope" }),
    );
    expect(resp.status).toBe(400);
    const body = (await resp.json()) as { error: string };
    expect(body.error).toMatch(/not valid JSON/i);
  });

  it("400 when multipart url path's declared fails Zod schema", async () => {
    const resp = await POST(
      multipartReq({
        url: "https://x.example/x.jpg",
        declared: JSON.stringify({ brand_name: "" }),
      }),
    );
    expect(resp.status).toBe(400);
    const body = (await resp.json()) as { error: string };
    expect(body.error).toMatch(/schema/i);
  });

  it("propagates UrlFetchError's status on the multipart url path", async () => {
    fetchUrlImageMock.mockRejectedValueOnce(
      new UrlFetchError("Too large.", 413),
    );
    const resp = await POST(
      multipartReq({
        url: "https://x.example/huge.jpg",
        declared: JSON.stringify(DECLARED_VALID),
      }),
    );
    expect(resp.status).toBe(413);
  });

  it("502 on generic fetch failure via the multipart url path", async () => {
    fetchUrlImageMock.mockRejectedValueOnce(new Error("socket hang up"));
    const resp = await POST(
      multipartReq({
        url: "https://x.example/x.jpg",
        declared: JSON.stringify(DECLARED_VALID),
      }),
    );
    expect(resp.status).toBe(502);
  });
});

describe("/api/verify — PDF error branches", () => {
  it("415 when the PDF is encrypted (PdfExtractError code=encrypted)", async () => {
    extractPdfFirstPageMock.mockRejectedValueOnce(
      new PdfExtractError("encrypted", "Password protected"),
    );
    const resp = await POST(
      multipartReq({
        image: {
          buffer: Buffer.from("%PDF-1.4\n"),
          type: "application/pdf",
          name: "locked.pdf",
        },
        declared: JSON.stringify(DECLARED_VALID),
      }),
    );
    expect(resp.status).toBe(415);
    const body = (await resp.json()) as { error: string };
    expect(body.error).toMatch(/password-protected/i);
  });

  it("400 when the PDF has no pages (PdfExtractError code=empty)", async () => {
    extractPdfFirstPageMock.mockRejectedValueOnce(
      new PdfExtractError("empty", "no pages"),
    );
    const resp = await POST(
      multipartReq({
        image: {
          buffer: Buffer.from("%PDF-1.4\n"),
          type: "application/pdf",
          name: "empty.pdf",
        },
        declared: JSON.stringify(DECLARED_VALID),
      }),
    );
    expect(resp.status).toBe(400);
    const body = (await resp.json()) as { error: string };
    expect(body.error).toMatch(/no pages/i);
  });

  it("500 when the PDF render fails (PdfExtractError code=render-failed)", async () => {
    extractPdfFirstPageMock.mockRejectedValueOnce(
      new PdfExtractError("render-failed", "rasterise failed: poppler crash"),
    );
    const resp = await POST(
      multipartReq({
        image: {
          buffer: Buffer.from("%PDF-1.4\n"),
          type: "application/pdf",
          name: "crash.pdf",
        },
        declared: JSON.stringify(DECLARED_VALID),
      }),
    );
    expect(resp.status).toBe(500);
  });

  it("500 when extractPdfFirstPage throws a generic (non-PdfExtractError) error", async () => {
    extractPdfFirstPageMock.mockRejectedValueOnce(new Error("disk full"));
    const resp = await POST(
      multipartReq({
        image: {
          buffer: Buffer.from("%PDF-1.4\n"),
          type: "application/pdf",
          name: "x.pdf",
        },
        declared: JSON.stringify(DECLARED_VALID),
      }),
    );
    expect(resp.status).toBe(500);
    const body = (await resp.json()) as { error: string };
    expect(body.error).toMatch(/PDF processing failed.*disk full/);
  });
});

describe("/api/verify — runVerify error branches", () => {
  it("504 + aborted:true when verifyLabel throws an AbortError", async () => {
    const abortErr = new Error("vision budget exceeded");
    abortErr.name = "AbortError";
    verifyLabelMock.mockRejectedValueOnce(abortErr);
    const resp = await POST(
      multipartReq({
        image: { buffer: await tinyJpeg(), type: "image/jpeg", name: "a.jpg" },
        declared: JSON.stringify(DECLARED_VALID),
      }),
    );
    expect(resp.status).toBe(504);
    const body = (await resp.json()) as { error: string; aborted: boolean };
    expect(body.aborted).toBe(true);
    expect(body.error).toMatch(/time budget/i);
  });

  it("500 on a non-abort verifyLabel error", async () => {
    verifyLabelMock.mockRejectedValueOnce(new Error("model 5xx"));
    const resp = await POST(
      multipartReq({
        image: { buffer: await tinyJpeg(), type: "image/jpeg", name: "a.jpg" },
        declared: JSON.stringify(DECLARED_VALID),
      }),
    );
    expect(resp.status).toBe(500);
    const body = (await resp.json()) as {
      error: string;
      aborted: boolean;
    };
    expect(body.aborted).toBe(false);
    expect(body.error).toMatch(/Verification failed.*model 5xx/);
  });

  it("echoes X-Request-Id back on a successful 200 when client sent it", async () => {
    const requestId = "5d8c1f4e-7a2b-4c91-b6e0-1234567890ab";
    const fd = new FormData();
    const blob = new Blob([(await tinyJpeg()) as unknown as BlobPart], {
      type: "image/jpeg",
    });
    fd.append("image", new File([blob], "a.jpg", { type: "image/jpeg" }));
    fd.append("declared", JSON.stringify(DECLARED_VALID));
    const req = new Request("http://test.local/api/verify", {
      method: "POST",
      body: fd,
      headers: {
        "x-forwarded-for": nextCallerIp(),
        "x-request-id": requestId,
      },
    });
    const resp = await POST(req);
    expect(resp.status).toBe(200);
    expect(resp.headers.get("X-Request-Id")).toBe(requestId);
  });

  it("echoes X-Request-Id on error responses too", async () => {
    const requestId = "ab123456-7a2b-4c91-b6e0-1234567890cd";
    verifyLabelMock.mockRejectedValueOnce(new Error("kaboom"));
    const fd = new FormData();
    const blob = new Blob([(await tinyJpeg()) as unknown as BlobPart], {
      type: "image/jpeg",
    });
    fd.append("image", new File([blob], "a.jpg", { type: "image/jpeg" }));
    fd.append("declared", JSON.stringify(DECLARED_VALID));
    const req = new Request("http://test.local/api/verify", {
      method: "POST",
      body: fd,
      headers: {
        "x-forwarded-for": nextCallerIp(),
        "x-request-id": requestId,
      },
    });
    const resp = await POST(req);
    expect(resp.status).toBe(500);
    expect(resp.headers.get("X-Request-Id")).toBe(requestId);
    const body = (await resp.json()) as { requestId: string };
    expect(body.requestId).toBe(requestId);
  });
});

describe("/api/verify — requiresHumanReview routing", () => {
  it("still returns 200 when result.requiresHumanReview is true (queue is best-effort)", async () => {
    verifyLabelMock.mockResolvedValueOnce(
      fakeVerifyResponse({
        verdict: "review",
        requiresHumanReview: true,
        reviewReasons: ["low confidence on brand"],
      }),
    );
    const resp = await POST(
      multipartReq({
        image: { buffer: await tinyJpeg(), type: "image/jpeg", name: "a.jpg" },
        declared: JSON.stringify(DECLARED_VALID),
      }),
    );
    expect(resp.status).toBe(200);
    const body = (await resp.json()) as VerifyResponse;
    expect(body.requiresHumanReview).toBe(true);
    expect(body.reviewReasons).toEqual(["low confidence on brand"]);
  });
});

describe("/api/verify — content-type fallback", () => {
  it("400 when body is empty multipart and JSON content-type wasn't set", async () => {
    // No content-type header → route falls into the multipart branch
    // and tries req.formData(); an empty body with no boundary fails.
    const req = new Request("http://test.local/api/verify", {
      method: "POST",
      body: "",
      headers: { "x-forwarded-for": nextCallerIp() },
    });
    const resp = await POST(req);
    expect(resp.status).toBe(400);
  });
});
