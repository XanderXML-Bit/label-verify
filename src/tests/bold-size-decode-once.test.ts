import { readFileSync, readdirSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { preprocessImage } from "@/lib/preprocess";
import {
  decodeBinary,
  strokeProxy,
  strokeProxyFromBinary,
} from "@/lib/validation/bold-size";
import type { OcrWord } from "@/lib/ocr";

// measureRelativeBold now decodes the label once and measures every OCR
// word from memory, instead of re-decoding the whole JPEG per word. The
// bold verdict is calibrated, so the two paths must give the same number
// for every word box, to the last bit.

function word(x: number, y: number, width: number, height: number): OcrWord {
  return { text: "w", confidence: 90, bbox: { x, y, width, height } } as OcrWord;
}

/** Deterministic word-sized boxes spread over the image, plus edge cases. */
function boxes(w: number, h: number): OcrWord[] {
  const out: OcrWord[] = [];
  let seed = 7;
  const rnd = (): number => {
    seed = (seed * 48271) % 2147483647;
    return seed / 2147483647;
  };
  for (let i = 0; i < 60; i++) {
    const bw = 8 + Math.floor(rnd() * 120);
    const bh = 6 + Math.floor(rnd() * 40);
    out.push(word(rnd() * (w - 4), rnd() * (h - 4), bw, bh));
  }
  // Boxes that run off the right / bottom edge and a degenerate one.
  out.push(word(w - 10, h - 10, 50, 50), word(0, 0, w + 20, 12), word(3, 3, 1, 9));
  return out;
}

const images = [
  path.join("public", "samples", "pass.jpg"),
  path.join("public", "samples", "fail.jpg"),
  ...readdirSync(path.join("test-data", "ai-generated", "labels"))
    .filter((f) => f.endsWith(".jpg"))
    .sort()
    .slice(0, 4)
    .map((f) => path.join("test-data", "ai-generated", "labels", f)),
];

describe("bold stroke proxy: decode-once path equals the per-word crop path", () => {
  for (const rel of images) {
    it(rel, async () => {
      const pre = await preprocessImage(readFileSync(path.join(process.cwd(), rel)));
      const binary = await decodeBinary(pre.buffer);
      expect(binary).not.toBeNull();
      expect(binary!.width).toBe(pre.width);
      expect(binary!.height).toBe(pre.height);
      let measured = 0;
      for (const wd of boxes(pre.width, pre.height)) {
        const slow = await strokeProxy(pre.buffer, wd, pre.width, pre.height);
        const fast = strokeProxyFromBinary(binary!, wd);
        expect(fast).toBe(slow);
        if (slow !== null) measured++;
      }
      // The comparison must cover real measurements, not only nulls.
      expect(measured).toBeGreaterThan(20);
    }, 60_000);
  }
});
