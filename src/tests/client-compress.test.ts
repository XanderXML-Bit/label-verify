// Wave-35e — coverage on src/lib/client-compress.ts.
//
// Wave-35e code-audit flagged this module as having zero direct
// tests despite handling every phone-photo upload (3-8 MB → 250-500
// KB). The pure helper `scaleToFit` is trivial to test directly;
// `compressImageInBrowser` is exercised across its SSR-bailout,
// non-image-MIME bailout, and same-file-back-on-decode-failure
// branches.

import { describe, expect, it, vi, beforeEach, afterEach } from "vitest";
import { compressImageInBrowser, scaleToFit } from "@/lib/client-compress";

describe("scaleToFit — pure aspect-preserving downscale", () => {
  it("returns inputs unchanged when both dims fit under the cap", () => {
    expect(scaleToFit(800, 600, 1600)).toEqual({ width: 800, height: 600 });
  });

  it("returns inputs unchanged when the long edge exactly equals the cap", () => {
    expect(scaleToFit(1600, 1200, 1600)).toEqual({ width: 1600, height: 1200 });
    expect(scaleToFit(800, 1600, 1600)).toEqual({ width: 800, height: 1600 });
  });

  it("scales 4032×3024 (typical phone photo) to ≤1600 long edge while preserving aspect", () => {
    const out = scaleToFit(4032, 3024, 1600);
    expect(Math.max(out.width, out.height)).toBe(1600);
    // Aspect ratio preserved to within ±1 px (rounding).
    expect(Math.abs(out.width / out.height - 4032 / 3024)).toBeLessThan(0.01);
  });

  it("scales portrait phone photos (3024×4032) symmetrically", () => {
    const out = scaleToFit(3024, 4032, 1600);
    expect(Math.max(out.width, out.height)).toBe(1600);
    expect(Math.abs(out.width / out.height - 3024 / 4032)).toBeLessThan(0.01);
  });

  it("supports a custom cap value", () => {
    const out = scaleToFit(3000, 2000, 2000);
    expect(Math.max(out.width, out.height)).toBe(2000);
  });

  it("clamps width and height to at least 1 even on pathological inputs", () => {
    // A 100×1 source scaled to a 1-edge cap would round height to 0
    // without the Math.max guard. The function must NEVER return a
    // zero-dim canvas spec.
    const out = scaleToFit(100, 1, 1);
    expect(out.width).toBeGreaterThanOrEqual(1);
    expect(out.height).toBeGreaterThanOrEqual(1);
  });

  it("does not mutate input numbers (returns a new object)", () => {
    const src = { w: 1000, h: 2000 };
    const out = scaleToFit(src.w, src.h, 500);
    expect(src.w).toBe(1000);
    expect(src.h).toBe(2000);
    expect(out).not.toBe(src);
  });
});

describe("compressImageInBrowser — SSR / non-DOM bailout", () => {
  const origWindow = globalThis.window;
  const origDocument = globalThis.document;
  const origURL = globalThis.URL;

  afterEach(() => {
    // Restore environment so other tests aren't affected.
    Object.defineProperty(globalThis, "window", { value: origWindow, configurable: true });
    Object.defineProperty(globalThis, "document", { value: origDocument, configurable: true });
    Object.defineProperty(globalThis, "URL", { value: origURL, configurable: true });
  });

  it("returns the file unchanged when `window` is undefined (SSR)", async () => {
    Object.defineProperty(globalThis, "window", { value: undefined, configurable: true });
    const file = new File(["x"], "test.jpg", { type: "image/jpeg" });
    const out = await compressImageInBrowser(file);
    expect(out).toBe(file);
  });

  it("returns the file unchanged when `document` is undefined", async () => {
    Object.defineProperty(globalThis, "document", { value: undefined, configurable: true });
    const file = new File(["x"], "test.jpg", { type: "image/jpeg" });
    const out = await compressImageInBrowser(file);
    expect(out).toBe(file);
  });

  it("returns the file unchanged when `URL` is undefined (defensive)", async () => {
    Object.defineProperty(globalThis, "URL", { value: undefined, configurable: true });
    const file = new File(["x"], "test.jpg", { type: "image/jpeg" });
    const out = await compressImageInBrowser(file);
    expect(out).toBe(file);
  });
});

describe("compressImageInBrowser — MIME-type bailout", () => {
  it("returns a PDF file unchanged (not an image)", async () => {
    const file = new File([new Uint8Array(10)], "doc.pdf", { type: "application/pdf" });
    const out = await compressImageInBrowser(file);
    expect(out).toBe(file);
  });

  it("returns a JSON file unchanged", async () => {
    const file = new File(['{"k":"v"}'], "data.json", { type: "application/json" });
    const out = await compressImageInBrowser(file);
    expect(out).toBe(file);
  });

  it("returns a CSV file unchanged", async () => {
    const file = new File(["a,b\n1,2"], "data.csv", { type: "text/csv" });
    const out = await compressImageInBrowser(file);
    expect(out).toBe(file);
  });

  it("returns an empty-MIME file unchanged (Windows Explorer quirk)", async () => {
    const file = new File(["x"], "unknown.bin", { type: "" });
    const out = await compressImageInBrowser(file);
    expect(out).toBe(file);
  });
});

describe("compressImageInBrowser — image-decode failure fallback (jsdom path)", () => {
  // jsdom's <img> implementation does NOT actually decode pixel data —
  // calling `.src = url` does not fire `onload` for blob:/object URLs
  // backing real image bytes. The function's try/catch should land us
  // in the `catch` branch and return the original file.

  beforeEach(() => {
    // Ensure we're in a "browser-like" environment so the SSR bailout
    // doesn't fire and we actually hit the image-decode path.
    if (typeof window === "undefined") {
      // jsdom should provide this; skip the test if not available.
      return;
    }
  });

  it("returns the original file when the browser can't decode the bytes (HEIC, corrupted JPEG, etc.)", async () => {
    if (typeof window === "undefined") return; // skip in non-jsdom
    // 8 bytes of non-image data; jsdom's <img>.load will error out.
    const fakeJpeg = new File([new Uint8Array([0x00, 0x01, 0x02])], "broken.jpg", {
      type: "image/jpeg",
    });
    const out = await compressImageInBrowser(fakeJpeg);
    expect(out).toBe(fakeJpeg);
  });

  it("revokes the createObjectURL it allocated even on the decode-failure path", async () => {
    if (typeof window === "undefined") return;
    // Spy on URL.revokeObjectURL to confirm cleanup. The createObjectURL
    // call is hit on every image path; revokeObjectURL is in the
    // `finally` block. A future refactor that drops the cleanup would
    // leak blob URLs across uploads.
    const revokeSpy = vi.spyOn(URL, "revokeObjectURL");
    const fakeJpeg = new File([new Uint8Array([0x00, 0x01, 0x02])], "broken.jpg", {
      type: "image/jpeg",
    });
    await compressImageInBrowser(fakeJpeg);
    expect(revokeSpy).toHaveBeenCalled();
    revokeSpy.mockRestore();
  });
});

describe("compressImageInBrowser — option overrides", () => {
  it("accepts a custom maxEdge without throwing", async () => {
    if (typeof window === "undefined") return;
    const file = new File([new Uint8Array([0])], "small.jpg", { type: "image/jpeg" });
    // Even if the image doesn't decode in jsdom (returns file unchanged),
    // the options object must parse without TypeScript / runtime errors.
    const out = await compressImageInBrowser(file, { maxEdge: 800 });
    expect(out).toBeInstanceOf(File);
  });

  it("accepts a custom quality without throwing", async () => {
    if (typeof window === "undefined") return;
    const file = new File([new Uint8Array([0])], "small.jpg", { type: "image/jpeg" });
    const out = await compressImageInBrowser(file, { quality: 0.5 });
    expect(out).toBeInstanceOf(File);
  });
});
