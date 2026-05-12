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
    const input = await solidJpeg(2400, 1200);
    const pre = await preprocessImage(input);
    // Default maxEdge is 1600.
    expect(Math.max(pre.width, pre.height)).toBeLessThanOrEqual(1600);
    expect(pre.width).toBe(1600);
    // 1200 * (1600/2400) = 800.
    expect(pre.height).toBe(800);
  });

  it("does not enlarge when the input is already under the maxEdge", async () => {
    const input = await solidJpeg(800, 600);
    const pre = await preprocessImage(input);
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
    const png = await preprocessImage(await solidPng(300, 300));
    const webp = await preprocessImage(await solidWebp(300, 300));
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
    const pre = await preprocessImage(tagged);
    expect(pre.width).toBe(100);
    expect(pre.height).toBe(200);
  });
});
