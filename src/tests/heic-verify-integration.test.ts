// Wave-35m — HEIC end-to-end through /api/verify.
//
// The iPhone reviewer use case ships HEIC label photos by default —
// iOS Camera Roll stores HEIC unless the user has flipped "Most
// Compatible" in Settings → Camera → Formats. `ACCEPTED_MIME` on
// `/api/verify` already lists `image/heic` and `image/heif`, but
// nothing pinned the end-to-end contract that an HEIC upload
// actually flows past the MIME gate, hits verifyLabel exactly once,
// and round-trips a VerifyResponse to the client.
//
// This file pins that contract. verifyLabel + the preprocess
// dependencies are mocked so the test doesn't need a real HEIC
// decoder — we're testing the route's wiring, not pixel decode.

import { describe, expect, it, vi, beforeEach } from "vitest";

const verifyLabelMock = vi.fn();
vi.mock("@/lib/verify", () => ({
  verifyLabel: (...args: unknown[]) => verifyLabelMock(...args),
}));

// Tesseract / OCR is loaded by `@/lib/verify` not by the route itself,
// but mock it defensively so a Tesseract WASM-init crash inside any
// nested import doesn't poison the test.
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

import { POST } from "@/app/api/verify/route";
import type { VerifyResponse } from "@/lib/types";

const DECLARED = {
  brand_name: "Mill Creek",
  class_type: "Pilsner",
  class_category: "beer" as const,
  abv_percent: 5.2,
  net_contents: { value: 12, unit: "fl_oz" as const },
  producer: "Mill Creek Beverage Co., Asheville, NC",
  country_of_origin: "USA",
};

function fakeVerifyResponse(): VerifyResponse {
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
  };
}

// Synthesise an HEIC-typed File. The route doesn't decode bytes
// (verifyLabel is mocked), so any non-empty Buffer with the
// `image/heic` MIME label is enough to exercise the wiring. The
// real HEIC "ftyp" magic isn't required for the route to accept
// the upload — only the declared MIME is checked at the route
// boundary.
function heicFile(name = "iphone-label.heic"): File {
  const buf = Buffer.from([
    // HEIC files start with `....ftypheic` (the "ftyp" major-brand
    // box). We include the magic so any future code that sniffs
    // headers won't get confused. The route itself doesn't sniff —
    // it trusts the multipart-declared MIME.
    0x00, 0x00, 0x00, 0x20, 0x66, 0x74, 0x79, 0x70, 0x68, 0x65, 0x69, 0x63,
    0x00, 0x00, 0x00, 0x00, 0x68, 0x65, 0x69, 0x63, 0x6d, 0x69, 0x66, 0x31,
  ]);
  const blob = new Blob([buf as unknown as BlobPart], { type: "image/heic" });
  return new File([blob], name, { type: "image/heic" });
}

let ipCounter = 13_000;
function freshIp(): string {
  ipCounter++;
  return `198.18.${(ipCounter >> 8) & 0xff}.${ipCounter & 0xff}`;
}

function multipartReq(file: File): Request {
  const fd = new FormData();
  fd.append("image", file);
  fd.append("declared", JSON.stringify(DECLARED));
  return new Request("http://test.local/api/verify", {
    method: "POST",
    body: fd,
    headers: { "x-forwarded-for": freshIp() },
  });
}

beforeEach(() => {
  verifyLabelMock.mockReset();
  verifyLabelMock.mockResolvedValue(fakeVerifyResponse());
});

describe("/api/verify — HEIC end-to-end (iPhone reviewer path)", () => {
  it("accepts an image/heic upload, routes past the MIME gate, and fires verifyLabel exactly once", async () => {
    const resp = await POST(multipartReq(heicFile("photo.heic")));
    expect(resp.status).toBe(200);
    expect(verifyLabelMock).toHaveBeenCalledTimes(1);
    const body = (await resp.json()) as VerifyResponse;
    expect(body.verdict).toBe("pass");
    expect(body.modelId).toBe("mock:test");
    // First positional arg is the buffer — confirm it actually
    // reached the orchestrator (not stripped by the route).
    const args = verifyLabelMock.mock.calls[0];
    expect(args?.[0]).toBeInstanceOf(Buffer);
    expect((args?.[0] as Buffer).byteLength).toBeGreaterThan(0);
  });

  it("accepts image/heif (sibling MIME) on the same path", async () => {
    // Some iPads / older iPhones ship HEIF instead of HEIC; same
    // container, slightly different brand. `ACCEPTED_MIME` lists
    // both, so this should behave identically.
    const buf = Buffer.from([0x00, 0x00, 0x00, 0x20, 0x66, 0x74, 0x79, 0x70]);
    const blob = new Blob([buf as unknown as BlobPart], { type: "image/heif" });
    const file = new File([blob], "photo.heif", { type: "image/heif" });
    const resp = await POST(multipartReq(file));
    expect(resp.status).toBe(200);
    expect(verifyLabelMock).toHaveBeenCalledTimes(1);
  });

  it("rejects an image/avif upload with 415 (NOT in the allowlist, regression guard)", async () => {
    // Negative case: AVIF is a different image format that ChatGPT,
    // image-CDNs, and some Android cameras emit. We deliberately
    // do NOT accept it on /api/verify because Gemini's vision API
    // hasn't been validated against AVIF inputs — quietly accepting
    // would land the user with a vision-time 4xx after the page
    // pretends to be processing. Better to surface the 415 at the
    // MIME gate so the user can convert / re-export.
    const buf = Buffer.from([0x00, 0x00, 0x00, 0x20, 0x66, 0x74, 0x79, 0x70]);
    const blob = new Blob([buf as unknown as BlobPart], { type: "image/avif" });
    const file = new File([blob], "x.avif", { type: "image/avif" });
    const resp = await POST(multipartReq(file));
    expect(resp.status).toBe(415);
    expect(verifyLabelMock).not.toHaveBeenCalled();
  });
});
