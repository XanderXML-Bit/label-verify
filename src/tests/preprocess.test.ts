import { describe, expect, it } from "vitest";
import sharp from "sharp";
import { preprocessImage } from "@/lib/preprocess";

async function solidJpeg(width: number, height: number): Promise<Buffer> {
  return await sharp({
    create: { width, height, channels: 3, background: "#7f7f7f" },
  })
    .jpeg({ quality: 85 })
    .toBuffer();
}

async function solidPng(width: number, height: number): Promise<Buffer> {
  return await sharp({
    create: { width, height, channels: 3, background: "#aabbcc" },
  })
    .png()
    .toBuffer();
}

async function solidWebp(width: number, height: number): Promise<Buffer> {
  return await sharp({
    create: { width, height, channels: 3, background: "#446688" },
  })
    .webp()
    .toBuffer();
}

describe("preprocessImage", () => {
  it("resizes when the longest edge exceeds the maxEdge target", async () => {
    const input = await solidJpeg(3000, 1500);
    const pre = await preprocessImage(input);
    // Wave-31j default maxEdge is 2000.
    expect(Math.max(pre.width, pre.height)).toBeLessThanOrEqual(2000);
    expect(pre.width).toBe(2000);
    // 1500 * (2000/3000) = 1000.
    expect(pre.height).toBe(1000);
  });

  it("wave-31j: enlarges sub-target images via Lanczos when enlarge=true", async () => {
    const input = await solidJpeg(1024, 1536);
    // setup.ts pins LV_ENLARGE=0 for the wider test suite so existing
    // integration tests preserve pre-wave-31j behaviour. We pass
    // `enlarge: true` explicitly here to test the production default.
    const pre = await preprocessImage(input, { enlarge: true });
    // 1024×1536 → 2000 long-edge with aspect ratio preserved.
    // 1024 * (2000/1536) ≈ 1333.
    expect(pre.height).toBe(2000);
    expect(pre.width).toBe(1333);
  });

  it("can opt out of enlargement (legacy behaviour)", async () => {
    const input = await solidJpeg(800, 600);
    const pre = await preprocessImage(input, { enlarge: false });
    expect(pre.width).toBe(800);
    expect(pre.height).toBe(600);
  });

  it("returns a JPEG buffer regardless of input format (PNG in → JPEG out)", async () => {
    const input = await solidPng(400, 300);
    const pre = await preprocessImage(input);
    // JPEG SOI marker is FF D8 FF.
    expect(pre.buffer[0]).toBe(0xff);
    expect(pre.buffer[1]).toBe(0xd8);
    expect(pre.buffer[2]).toBe(0xff);
  });

  it("populates bytesIn and bytesOut with positive integers", async () => {
    const input = await solidJpeg(800, 600);
    const pre = await preprocessImage(input);
    expect(pre.bytesIn).toBe(input.byteLength);
    expect(pre.bytesOut).toBeGreaterThan(0);
    expect(pre.bytesOut).toBe(pre.buffer.byteLength);
  });

  it("autoContrast: explicit `false` produces a different (or equal-size) buffer than `true`", async () => {
    const input = await solidJpeg(800, 600);
    const withNorm = await preprocessImage(input, { autoContrast: true });
    const noNorm = await preprocessImage(input, { autoContrast: false });
    // Both should succeed and produce a non-empty JPEG.
    expect(withNorm.buffer.byteLength).toBeGreaterThan(0);
    expect(noNorm.buffer.byteLength).toBeGreaterThan(0);
    // For a solid-color image the histograms are degenerate and `normalize`
    // is effectively a no-op, so we don't assert that the buffers differ —
    // we only assert that the autoContrast option is *accepted* and doesn't
    // explode.
    expect(noNorm.width).toBe(withNorm.width);
  });

  it("accepts PNG and WebP inputs without throwing", async () => {
    // Use enlarge:false to keep small inputs at native size for the
    // dimension assertion below.
    const png = await preprocessImage(await solidPng(300, 300), { enlarge: false });
    const webp = await preprocessImage(await solidWebp(300, 300), { enlarge: false });
    expect(png.width).toBe(300);
    expect(webp.width).toBe(300);
    // Both should be re-encoded as JPEG.
    expect(png.buffer[0]).toBe(0xff);
    expect(webp.buffer[0]).toBe(0xff);
  });

  it("EXIF orientation 6 (rotate 90° CW) swaps width/height post-rotate", async () => {
    // Build a 200x100 JPEG with EXIF Orientation = 6. sharp's .rotate()
    // with no args means "auto-orient using EXIF" — after rotation the
    // logical dimensions become 100x200.
    const tagged = await sharp({
      create: { width: 200, height: 100, channels: 3, background: "#abcdef" },
    })
      .withMetadata({ orientation: 6 })
      .jpeg()
      .toBuffer();
    const pre = await preprocessImage(tagged, { enlarge: false });
    expect(pre.width).toBe(100);
    expect(pre.height).toBe(200);
  });
});
