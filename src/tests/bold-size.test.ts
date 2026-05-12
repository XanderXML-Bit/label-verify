import { describe, it, expect } from "vitest";
import sharp from "sharp";
import {
  findPrefixWords,
  findBodyWords,
  measureSizeMm,
  measureRelativeBold,
} from "@/lib/validation/bold-size";
import { validateGovernmentWarning } from "@/lib/validation/government-warning-validator";
import type { OcrWord } from "@/lib/ocr";
import { canonicalStatement } from "@/lib/validation/government-warning";

// ─── Helpers ────────────────────────────────────────────────────────────────

function word(
  text: string,
  bbox: { x: number; y: number; width: number; height: number },
  confidence = 0.95,
): OcrWord {
  return { text, bbox, confidence };
}

// A canonical "GOVERNMENT WARNING: <body>" word list, all on the same y-band
// for the prefix and then a body-band below it.
function compliantWordList(opts: {
  prefixHeight?: number;
  bodyHeight?: number;
  prefixYDelta?: number;
} = {}): OcrWord[] {
  const ph = opts.prefixHeight ?? 40;
  const bh = opts.bodyHeight ?? 20;
  const prefixY = opts.prefixYDelta ?? 100;
  const bodyY = prefixY + ph + 20;
  return [
    word("GOVERNMENT", { x: 100, y: prefixY, width: 300, height: ph }),
    word("WARNING:", { x: 420, y: prefixY, width: 200, height: ph }),
    word("(1)", { x: 100, y: bodyY, width: 30, height: bh }),
    word("According", { x: 140, y: bodyY, width: 100, height: bh }),
    word("to", { x: 250, y: bodyY, width: 30, height: bh }),
    word("the", { x: 290, y: bodyY, width: 40, height: bh }),
    word("Surgeon", { x: 340, y: bodyY, width: 90, height: bh }),
    word("General", { x: 440, y: bodyY, width: 90, height: bh }),
    word("women", { x: 100, y: bodyY + 30, width: 80, height: bh }),
    word("should", { x: 190, y: bodyY + 30, width: 80, height: bh }),
    word("not", { x: 280, y: bodyY + 30, width: 40, height: bh }),
    word("drink", { x: 330, y: bodyY + 30, width: 70, height: bh }),
  ];
}

// ─── findPrefixWords ────────────────────────────────────────────────────────

describe("findPrefixWords", () => {
  it("finds GOVERNMENT WARNING in a clean word list", () => {
    const got = findPrefixWords(compliantWordList());
    expect(got.length).toBeGreaterThanOrEqual(2);
    expect(got[0]!.text).toMatch(/GOVERNMENT/i);
    expect(got[1]!.text).toMatch(/WARNING/i);
  });

  it("tolerates a single OCR error: G0VERNMENT WARNING (zero for O)", () => {
    const words = compliantWordList();
    words[0] = word(
      "G0VERNMENT",
      words[0]!.bbox,
      0.9,
    );
    const got = findPrefixWords(words);
    expect(got.length).toBeGreaterThanOrEqual(2);
    expect(got[0]!.text).toBe("G0VERNMENT");
  });

  it("returns empty when WARNING is missing", () => {
    const words = compliantWordList().filter((w) => !/WARNING/i.test(w.text));
    expect(findPrefixWords(words)).toEqual([]);
  });

  it("returns empty when GOVERNMENT and WARNING are not on the same y-band", () => {
    const a = word("GOVERNMENT", { x: 100, y: 100, width: 300, height: 40 });
    const b = word("WARNING", { x: 420, y: 500, width: 200, height: 40 });
    expect(findPrefixWords([a, b])).toEqual([]);
  });

  it("handles empty input gracefully", () => {
    expect(findPrefixWords([])).toEqual([]);
  });
});

// ─── findBodyWords ──────────────────────────────────────────────────────────

describe("findBodyWords", () => {
  it("returns words after the prefix in the same column", () => {
    const words = compliantWordList();
    const prefix = findPrefixWords(words);
    const body = findBodyWords(words, prefix);
    expect(body.length).toBeGreaterThan(0);
    // None of the prefix words should be in the body.
    for (const p of prefix) expect(body).not.toContain(p);
  });

  it("returns empty when prefix is empty", () => {
    expect(findBodyWords(compliantWordList(), [])).toEqual([]);
  });

  it("skips words far below the prefix block (different region)", () => {
    const words = compliantWordList();
    words.push(
      word("UNRELATED", { x: 100, y: 5000, width: 100, height: 20 }),
    );
    const prefix = findPrefixWords(words);
    const body = findBodyWords(words, prefix);
    expect(body.find((w) => w.text === "UNRELATED")).toBeUndefined();
  });
});

// ─── measureSizeMm ──────────────────────────────────────────────────────────

describe("measureSizeMm", () => {
  it("returns expected mm for a known bbox + container size (large)", () => {
    // 1600 px long edge, 750ml → assumedLabelHeightMm = 100mm → 16 px/mm.
    // Prefix word with height 40 px → 2.5mm; minMm = 2mm; pass = true.
    const prefix: OcrWord[] = [
      word("GOVERNMENT", { x: 0, y: 0, width: 300, height: 40 }),
      word("WARNING", { x: 320, y: 0, width: 200, height: 40 }),
    ];
    const r = measureSizeMm(
      prefix,
      { width: 1200, height: 1600 },
      { value: 750, unit: "ml" },
    );
    expect(r.minMm).toBe(2);
    expect(r.prefixMm).toBeCloseTo(2.5, 2);
    expect(r.pass).toBe(true);
  });

  it("uses the SMALL container minimum (1mm) for ≤237ml", () => {
    // 1600 px long edge, 50ml → assumedLabelHeightMm = 30mm → ~53 px/mm.
    // Height 60 → ~1.125mm; minMm = 1mm; pass = true.
    const prefix: OcrWord[] = [
      word("GOVERNMENT", { x: 0, y: 0, width: 300, height: 60 }),
      word("WARNING", { x: 320, y: 0, width: 200, height: 60 }),
    ];
    const r = measureSizeMm(
      prefix,
      { width: 1200, height: 1600 },
      { value: 50, unit: "ml" },
    );
    expect(r.minMm).toBe(1);
    expect(r.pass).toBe(true);
  });

  it("uses the MAXIMUM prefix word height (Tesseract bboxes are tight)", () => {
    // Two prefix words with different heights — should pick the bigger one.
    const prefix: OcrWord[] = [
      word("GOVERNMENT", { x: 0, y: 0, width: 300, height: 20 }),
      word("WARNING", { x: 320, y: 0, width: 200, height: 40 }),
    ];
    const r = measureSizeMm(
      prefix,
      { width: 1200, height: 1600 },
      { value: 750, unit: "ml" },
    );
    // px/mm = 16, max height = 40 → 2.5mm.
    expect(r.prefixMm).toBeCloseTo(2.5, 2);
  });

  it("returns (0, fail) when prefix is empty", () => {
    const r = measureSizeMm(
      [],
      { width: 1200, height: 1600 },
      { value: 750, unit: "ml" },
    );
    expect(r.prefixMm).toBe(0);
    expect(r.pass).toBe(false);
  });
});

// ─── measureRelativeBold (real sharp pass) ──────────────────────────────────

describe("measureRelativeBold", () => {
  it("returns a higher ratio when the prefix has thicker strokes", async () => {
    // Build a 200×100 white image with a thick black rectangle on the
    // left (prefix region) and a thin black rectangle on the right (body
    // region). The thick block should produce a higher dark-pixel-per-row
    // proxy than the thin block, so ratio > 1.
    const w = 200;
    const h = 100;
    const channels = 3;
    const data = Buffer.alloc(w * h * channels, 255); // white
    function paintRect(x0: number, y0: number, x1: number, y1: number) {
      for (let y = y0; y < y1; y++) {
        for (let x = x0; x < x1; x++) {
          const i = (y * w + x) * channels;
          data[i] = 0;
          data[i + 1] = 0;
          data[i + 2] = 0;
        }
      }
    }
    // "Prefix" block: thick (40px x 30px = 1200 dark px, height 30 → proxy 40).
    paintRect(10, 30, 50, 60);
    // "Body" block: thin stroke (40px x 5px = 200 dark px, height 5 → proxy 40 in
    // the dark band only; but the bbox we pass for body is taller, so dark/height
    // is lower).
    paintRect(120, 40, 160, 45);

    const buf = await sharp(data, { raw: { width: w, height: h, channels } })
      .png()
      .toBuffer();

    const prefix: OcrWord[] = [
      word("GOVERNMENT", { x: 10, y: 30, width: 40, height: 30 }),
    ];
    const body: OcrWord[] = [
      word("body", { x: 120, y: 30, width: 40, height: 30 }),
    ];

    const m = await measureRelativeBold(buf, prefix, body);
    // Prefix block is dense (filled rectangle), body block has a thin stroke
    // within a taller bbox → prefix dark/height > body dark/height → ratio > 1.
    expect(m.ratio).toBeGreaterThan(1);
    expect(m.confidence).toBeGreaterThan(0);
  });

  it("returns ratio=1, confidence=0 on empty inputs", async () => {
    const buf = await sharp({
      create: { width: 10, height: 10, channels: 3, background: "#fff" },
    })
      .png()
      .toBuffer();
    const r = await measureRelativeBold(buf, [], []);
    expect(r.ratio).toBe(1);
    expect(r.confidence).toBe(0);
  });
});

// ─── Validator with OCR context ─────────────────────────────────────────────

describe("validateGovernmentWarning with OCR context", () => {
  // Build a 1600×1200 buffer that contains thick prefix glyphs and thin
  // body glyphs at the exact bboxes we hand in.
  async function makeTestImage(opts: {
    prefixBboxes: { x: number; y: number; w: number; h: number; stroke: number }[];
    bodyBboxes: { x: number; y: number; w: number; h: number; stroke: number }[];
  }): Promise<Buffer> {
    const W = 1600;
    const H = 1200;
    const data = Buffer.alloc(W * H * 3, 255);
    function paint(x0: number, y0: number, x1: number, y1: number) {
      for (let y = Math.max(0, y0); y < Math.min(H, y1); y++) {
        for (let x = Math.max(0, x0); x < Math.min(W, x1); x++) {
          const i = (y * W + x) * 3;
          data[i] = 0;
          data[i + 1] = 0;
          data[i + 2] = 0;
        }
      }
    }
    for (const b of opts.prefixBboxes) {
      // Paint a filled rectangle of `stroke` rows centered vertically.
      const top = b.y + Math.floor((b.h - b.stroke) / 2);
      paint(b.x, top, b.x + b.w, top + b.stroke);
    }
    for (const b of opts.bodyBboxes) {
      const top = b.y + Math.floor((b.h - b.stroke) / 2);
      paint(b.x, top, b.x + b.w, top + b.stroke);
    }
    return await sharp(data, { raw: { width: W, height: H, channels: 3 } })
      .png()
      .toBuffer();
  }

  const fullyCompliant = {
    raw_text: canonicalStatement(),
    prefix_text: "GOVERNMENT WARNING",
    prefix_bbox: { x: 100, y: 200, width: 400, height: 40 },
    prefix_appears_bold: true,
    prefix_appears_caps: true,
  };
  const LARGE = { value: 750, unit: "ml" as const };

  it("size subscore reads OCR prefix height when ocrContext is provided", async () => {
    // OCR shows a TINY prefix (5 px tall on a 1600px image, 750ml bottle).
    // That's ~0.3mm — well below the 2mm minimum × 50% floor → size=fail.
    const tinyPrefix = [
      word("GOVERNMENT", { x: 100, y: 200, width: 300, height: 5 }),
      word("WARNING", { x: 420, y: 200, width: 200, height: 5 }),
      word("(1)", { x: 100, y: 250, width: 30, height: 20 }),
      word("According", { x: 140, y: 250, width: 100, height: 20 }),
      word("to", { x: 250, y: 250, width: 30, height: 20 }),
      word("the", { x: 290, y: 250, width: 40, height: 20 }),
    ];
    const image = await makeTestImage({
      prefixBboxes: [
        { x: 100, y: 200, w: 300, h: 5, stroke: 5 },
        { x: 420, y: 200, w: 200, h: 5, stroke: 5 },
      ],
      bodyBboxes: [
        { x: 100, y: 250, w: 30, h: 20, stroke: 2 },
        { x: 140, y: 250, w: 100, h: 20, stroke: 2 },
        { x: 250, y: 250, w: 30, h: 20, stroke: 2 },
        { x: 290, y: 250, w: 40, h: 20, stroke: 2 },
      ],
    });

    const withoutOcr = await validateGovernmentWarning({
      extracted: fullyCompliant, // model claims BIG prefix bbox
      declaredNetContents: LARGE,
      imageDimsPx: { width: 1600, height: 1200 },
    });
    // Without OCR, validator trusts the model's big bbox → size=pass.
    expect(withoutOcr.subscores.size.status).toBe("pass");

    const withOcr = await validateGovernmentWarning({
      extracted: fullyCompliant,
      declaredNetContents: LARGE,
      imageDimsPx: { width: 1600, height: 1200 },
      ocrContext: { words: tinyPrefix, imageBuffer: image },
    });
    // With OCR, the validator sees a 5px-tall prefix and downgrades the
    // size subscore (a regulator-defensible measurement).
    expect(withOcr.subscores.size.status).not.toBe("pass");
  });

  it("size pass when OCR sees a normal-sized prefix", async () => {
    // 40 px on 1600x1200, 750ml → 2.5mm > 2mm.
    const normalPrefix = [
      word("GOVERNMENT", { x: 100, y: 200, width: 300, height: 40 }),
      word("WARNING", { x: 420, y: 200, width: 200, height: 40 }),
      word("(1)", { x: 100, y: 260, width: 30, height: 20 }),
      word("According", { x: 140, y: 260, width: 100, height: 20 }),
      word("to", { x: 250, y: 260, width: 30, height: 20 }),
      word("the", { x: 290, y: 260, width: 40, height: 20 }),
    ];
    // Use thick prefix strokes and thin body strokes so the bold ratio is
    // comfortably > 1.4 (pass).
    const image = await makeTestImage({
      prefixBboxes: [
        { x: 100, y: 200, w: 300, h: 40, stroke: 25 },
        { x: 420, y: 200, w: 200, h: 40, stroke: 25 },
      ],
      bodyBboxes: [
        { x: 100, y: 260, w: 30, h: 20, stroke: 2 },
        { x: 140, y: 260, w: 100, h: 20, stroke: 2 },
        { x: 250, y: 260, w: 30, h: 20, stroke: 2 },
        { x: 290, y: 260, w: 40, h: 20, stroke: 2 },
      ],
    });
    const r = await validateGovernmentWarning({
      extracted: fullyCompliant,
      declaredNetContents: LARGE,
      imageDimsPx: { width: 1600, height: 1200 },
      ocrContext: { words: normalPrefix, imageBuffer: image },
    });
    expect(r.subscores.size.status).toBe("pass");
  });
});
