// Wave-35k bug replication — iOS batch upload collapses to one image.
//
// User-reported production bug 2026-05-18:
//   "Upload the files, they register. They show on the screen, on
//   the web app. It shows the application data and the images, and
//   yet still, it will report only one image being outputted, even
//   though there's five."
//
// Hypothesis: iOS Safari's Photos picker emits multiple files with
// the SAME `name` (often "image.jpg" for camera-roll photos, or the
// same `IMG_NNNN.HEIC` from a synced library when burst/screenshot
// metadata gets normalised). Distinct `size` + `lastModified` keeps
// the CLIENT-side `mergeFilesForRestage` dedup happy (so the user
// sees five thumbnails in the staging tray). But the server-side
// batch route has two Maps keyed by `stem(file.name)` —
//
//   1. `/api/verify/batch/route.ts:234`  (explicit-manifest path)
//        `fileMap.set(stem(value.name), value)`
//   2. `/api/verify/batch/route.ts:366`  (inline-manifest auto-detect)
//        `imagesByStem = new Map(candidateImages.map((img) =>
//                                  [pairingStem(img.name), img]))`
//
// — and the Map<string,File> overwrite-on-set semantics collapse
// all five iOS files into one entry. Only the LAST file with the
// shared stem survives. Manifest rows 2..N then either pair to the
// SAME File (caught by `matchedImagesInThisManifest.has`) or fail
// outright.
//
// This file pins the bug. The fix lives in wave-35k alongside.

import { describe, expect, it, vi } from "vitest";
import type { VerifyResponse } from "@/lib/types";

// Mock verifyLabel so we can count how many times the orchestrator
// actually fired (i.e. how many images the server thought it had).
const verifyLabelMock = vi.fn();
vi.mock("@/lib/verify", () => ({
  verifyLabel: (...args: unknown[]) => verifyLabelMock(...args),
}));

import { POST } from "@/app/api/verify/batch/route";

const TINY_JPEG = Buffer.from([0xff, 0xd8, 0xff]);

function fakeResult(): VerifyResponse {
  return {
    verdict: "pass",
    imageQuality: "good",
    fields: {} as VerifyResponse["fields"],
    governmentWarning: {} as VerifyResponse["governmentWarning"],
    extracted: {} as VerifyResponse["extracted"],
    timings: { preprocess: 1, ocr: null, vision: 1, matching: 1, total: 3 },
    modelId: "mock",
    modelVersion: "mock-v1",
    modeUsed: "default",
    requiresHumanReview: false,
    reviewReasons: [],
  };
}

function iphoneJpeg(displayName: string, sizePadding: number): File {
  // Pad the buffer so each File has a different `.size` — the
  // CLIENT-side dedup uses (name, size, lastModified) and the iPhone
  // multi-pick stages all five distinct files. Server-side, only
  // `.name` is consulted; that's the collision we're proving.
  const buf = Buffer.concat([TINY_JPEG, Buffer.alloc(sizePadding, 0x20)]);
  const blob = new Blob([buf as unknown as BlobPart], { type: "image/jpeg" });
  return new File([blob], displayName, {
    type: "image/jpeg",
    lastModified: 1_700_000_000_000 + sizePadding,
  });
}

let ipCounter = 11_000;
function freshIp(): string {
  ipCounter++;
  return `198.18.${(ipCounter >> 8) & 0xff}.${ipCounter & 0xff}`;
}

function makeReq(form: FormData): Request {
  return new Request("http://test.local/api/verify/batch", {
    method: "POST",
    body: form,
    headers: {
      "content-length": "1000",
      "x-forwarded-for": freshIp(),
    },
  });
}

const DECLARED_BASE = {
  brand_name: "Stone's Throw",
  class_type: "Pale Ale",
  class_category: "beer" as const,
  abv_percent: 6.4,
  net_contents: "12 fl_oz",
  producer: "Stone's Throw Brewing Co.",
  country_of_origin: "USA",
};

describe("/api/verify/batch — iOS 5-photos-all-named-the-same regression", () => {
  it("EXPLICIT MANIFEST: 5 manifest rows + 5 iPhone files (all 'image.jpg') should pair all 5", async () => {
    verifyLabelMock.mockReset();
    verifyLabelMock.mockResolvedValue(fakeResult());
    const fd = new FormData();
    // The reviewer's manifest references 5 distinct filenames (their
    // intended names). iOS doesn't know about the manifest — it
    // sends all 5 photos with the same on-device name.
    fd.append(
      "manifest",
      JSON.stringify([
        { filename: "image.jpg", ...DECLARED_BASE },
        { filename: "image.jpg", ...DECLARED_BASE },
        { filename: "image.jpg", ...DECLARED_BASE },
        { filename: "image.jpg", ...DECLARED_BASE },
        { filename: "image.jpg", ...DECLARED_BASE },
      ]),
    );
    // 5 iPhone photos, all named "image.jpg" — distinct size + mtime.
    fd.append("image", iphoneJpeg("image.jpg", 100));
    fd.append("image", iphoneJpeg("image.jpg", 200));
    fd.append("image", iphoneJpeg("image.jpg", 300));
    fd.append("image", iphoneJpeg("image.jpg", 400));
    fd.append("image", iphoneJpeg("image.jpg", 500));
    const resp = await POST(makeReq(fd));
    expect(resp.status).toBe(200);
    const body = (await resp.json()) as {
      count: number;
      pairing: { mode: string; pairedCount: number };
      pairingErrors: string[];
    };
    // This is the BUG: count was 1 even though 5 distinct files +
    // 5 manifest rows arrived. The fix should make this 5.
    expect(body.count).toBe(5);
    expect(body.pairing.pairedCount).toBe(5);
  });

  it("INLINE-MANIFEST CSV: 5-row roster + 5 iPhone files (all 'image.jpg') should pair all 5", async () => {
    verifyLabelMock.mockReset();
    verifyLabelMock.mockResolvedValue(fakeResult());
    const csv =
      "filename,brand_name,class_type,class_category,abv_percent,net_contents,producer,country_of_origin\n" +
      `image.jpg,Stone's Throw,Pale Ale,beer,6.4,12 fl_oz,Stone's Throw Brewing Co.,USA\n` +
      `image.jpg,Stone's Throw,Pale Ale,beer,6.4,12 fl_oz,Stone's Throw Brewing Co.,USA\n` +
      `image.jpg,Stone's Throw,Pale Ale,beer,6.4,12 fl_oz,Stone's Throw Brewing Co.,USA\n` +
      `image.jpg,Stone's Throw,Pale Ale,beer,6.4,12 fl_oz,Stone's Throw Brewing Co.,USA\n` +
      `image.jpg,Stone's Throw,Pale Ale,beer,6.4,12 fl_oz,Stone's Throw Brewing Co.,USA\n`;
    const fd = new FormData();
    // No `manifest` form field — the CSV is dropped as a regular
    // file alongside the images. Server should auto-detect it.
    fd.append("image", iphoneJpeg("image.jpg", 100));
    fd.append("image", iphoneJpeg("image.jpg", 200));
    fd.append("image", iphoneJpeg("image.jpg", 300));
    fd.append("image", iphoneJpeg("image.jpg", 400));
    fd.append("image", iphoneJpeg("image.jpg", 500));
    const blob = new Blob([csv], { type: "text/csv" });
    fd.append(
      "application",
      new File([blob], "roster.csv", { type: "text/csv" }),
    );
    const resp = await POST(makeReq(fd));
    expect(resp.status).toBe(200);
    const body = (await resp.json()) as {
      count: number;
      pairing: { mode: string; pairedCount: number };
    };
    expect(body.pairing.mode).toMatch(/inline-manifest/);
    expect(body.count).toBe(5);
  });

  it("MIXED: 3 unique-named uploads + 2 iPhone duplicates pair as 3 unique + 2 by upload order", async () => {
    // Regression guard for the multi-map fix: when uploads have a
    // mix of unique stems AND duplicate-name iOS stems, BOTH paths
    // (explicit-manifest + inline) must still produce N pairs.
    verifyLabelMock.mockReset();
    verifyLabelMock.mockResolvedValue(fakeResult());
    const fd = new FormData();
    fd.append(
      "manifest",
      JSON.stringify([
        { filename: "label-001.jpg", ...DECLARED_BASE },
        { filename: "label-002.jpg", ...DECLARED_BASE },
        { filename: "label-003.jpg", ...DECLARED_BASE },
        { filename: "image.jpg", ...DECLARED_BASE },
        { filename: "image.jpg", ...DECLARED_BASE },
      ]),
    );
    fd.append("image", iphoneJpeg("label-001.jpg", 100));
    fd.append("image", iphoneJpeg("label-002.jpg", 200));
    fd.append("image", iphoneJpeg("label-003.jpg", 300));
    fd.append("image", iphoneJpeg("image.jpg", 400));
    fd.append("image", iphoneJpeg("image.jpg", 500));
    const resp = await POST(makeReq(fd));
    expect(resp.status).toBe(200);
    const body = (await resp.json()) as {
      count: number;
      pairing: { mode: string; pairedCount: number };
    };
    expect(body.count).toBe(5);
    expect(body.pairing.pairedCount).toBe(5);
  });

  it("AUTO-PAIR + BROADCAST: 5 iPhone files (all 'image.jpg') + 1 single-product JSON should pair all 5 via broadcast", async () => {
    verifyLabelMock.mockReset();
    verifyLabelMock.mockResolvedValue(fakeResult());
    const prev = process.env.GOOGLE_API_KEY;
    delete process.env.GOOGLE_API_KEY;
    try {
      const fd = new FormData();
      fd.append("image", iphoneJpeg("image.jpg", 100));
      fd.append("image", iphoneJpeg("image.jpg", 200));
      fd.append("image", iphoneJpeg("image.jpg", 300));
      fd.append("image", iphoneJpeg("image.jpg", 400));
      fd.append("image", iphoneJpeg("image.jpg", 500));
      const json = JSON.stringify({
        brand_name: "Stone's Throw",
        class_type: "Pale Ale",
        class_category: "beer",
        abv_percent: 6.4,
        net_contents: "12 fl_oz",
        producer: "Stone's Throw Brewing Co.",
        country_of_origin: "USA",
      });
      const blob = new Blob([json], { type: "application/json" });
      fd.append(
        "application",
        new File([blob], "declared.json", { type: "application/json" }),
      );
      const resp = await POST(makeReq(fd));
      expect(resp.status).toBe(200);
      const body = (await resp.json()) as {
        count: number;
        pairing: { mode: string; broadcast?: boolean };
      };
      // Broadcast should fan the 1 JSON across all 5 photos.
      expect(body.count).toBe(5);
      expect(body.pairing.mode).toBe("auto-broadcast");
      expect(body.pairing.broadcast).toBe(true);
    } finally {
      if (prev !== undefined) process.env.GOOGLE_API_KEY = prev;
    }
  });
});
