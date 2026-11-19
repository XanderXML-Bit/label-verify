// Wave-35f — direct unit tests for src/lib/ocr/tesseract.ts.
//
// The wave-35e code-audit flagged this module as having no direct
// tests — every other test file mocks it away entirely. The bbox
// conversion (Tesseract emits `x0, y0, x1, y1` corners; our OcrWord
// uses `x, y, width, height` offsets) is the failure-prone part:
// a regression that swapped width/height or used wrong offsets
// would silently corrupt the Government-Warning bold + size
// measurements.
//
// We mock `tesseract.js`'s `createWorker` to return a worker whose
// `recognize` produces a known shape, then exercise the adapter's
// translation logic + the abort-signal preflight + the defensive
// `is_bold` runtime check.

import { describe, expect, it, vi, afterEach } from "vitest";
import type * as TesseractAdapter from "@/lib/ocr/tesseract";

interface MockTesseractWord {
  text: string;
  bbox: { x0: number; y0: number; x1: number; y1: number };
  confidence: number;
  is_bold?: unknown; // intentionally `unknown` — adapter defends against bad types
}

interface MockRecognizeResult {
  data: {
    text: string;
    blocks: {
      paragraphs: { lines: { words: MockTesseractWord[] }[] }[];
    }[] | null;
    confidence: number;
  };
}

function singleLineBlocks(words: MockTesseractWord[]) {
  return [{ paragraphs: [{ lines: [{ words }] }] }];
}

// Fresh module isolation per test so the worker singleton doesn't
// leak between cases (the adapter caches the createWorker promise).
async function loadAdapterWithMock(
  recognizeOutput: MockRecognizeResult | Error,
): Promise<typeof TesseractAdapter> {
  vi.resetModules();
  vi.doMock("tesseract.js", () => {
    return {
      createWorker: vi.fn(async () => {
        return {
          async recognize(
            _image: Buffer,
            _options?: unknown,
            output?: { blocks?: boolean },
          ) {
            if (recognizeOutput instanceof Error) throw recognizeOutput;
            return output?.blocks
              ? recognizeOutput
              : { data: { ...recognizeOutput.data, blocks: null } };
          },
        };
      }),
    };
  });
  return await import("@/lib/ocr/tesseract");
}

afterEach(() => {
  vi.doUnmock("tesseract.js");
  vi.resetModules();
});

it("restores word boxes from a recorded Tesseract.js 7 result", async () => {
  // Excerpt from recognizing the preprocessed public/samples/pass.jpg.
  const warningWords = [
    { text: "OVERNMENT", bbox: { x0: 253, y0: 1374, x1: 461, y1: 1460 }, confidence: 0 },
    { text: "WARNING:", bbox: { x0: 475, y0: 1395, x1: 660, y1: 1436 }, confidence: 96 },
  ];
  const bodyWords = [
    { text: "cE", bbox: { x0: 253, y0: 1438, x1: 357, y1: 1511 }, confidence: 46 },
    { text: "women", bbox: { x0: 370, y0: 1451, x1: 476, y1: 1484 }, confidence: 94 },
  ];
  const { tesseractEngine } = await loadAdapterWithMock({
    data: {
      text: "OVERNMENT WARNING: (1) According to the Surgeon\n" +
        "cE women should not drink alcoholic beverages\n",
      confidence: 59,
      blocks: [
        { paragraphs: [{ lines: [{ words: warningWords }, { words: bodyWords }] }] },
      ],
    },
  });

  const out = await tesseractEngine.run(Buffer.from("x"));
  expect(out.words).toStrictEqual([
    {
      text: "OVERNMENT",
      bbox: { x: 253, y: 1374, width: 208, height: 86 },
      confidence: 0,
      fontBold: undefined,
    },
    {
      text: "WARNING:",
      bbox: { x: 475, y: 1395, width: 185, height: 41 },
      confidence: 0.96,
      fontBold: undefined,
    },
    {
      text: "cE",
      bbox: { x: 253, y: 1438, width: 104, height: 73 },
      confidence: 0.46,
      fontBold: undefined,
    },
    {
      text: "women",
      bbox: { x: 370, y: 1451, width: 106, height: 33 },
      confidence: 0.94,
      fontBold: undefined,
    },
  ]);
});

describe("tesseractEngine.run — bbox conversion (x0/y0/x1/y1 → x/y/width/height)", () => {
  it("converts a single word's corner-form bbox to offset-form correctly", async () => {
    const { tesseractEngine } = await loadAdapterWithMock({
      data: {
        text: "GOVERNMENT",
        blocks: singleLineBlocks([
          {
            text: "GOVERNMENT",
            bbox: { x0: 10, y0: 20, x1: 110, y1: 50 },
            confidence: 92,
          },
        ]),
        confidence: 92,
      },
    });
    const out = await tesseractEngine.run(Buffer.from("x"));
    expect(out.words).toHaveLength(1);
    expect(out.words[0]).toMatchObject({
      text: "GOVERNMENT",
      bbox: { x: 10, y: 20, width: 100, height: 30 }, // (110-10)=100, (50-20)=30
      confidence: 0.92, // confidence divided by 100
    });
  });

  it("handles multiple words and preserves order", async () => {
    const { tesseractEngine } = await loadAdapterWithMock({
      data: {
        text: "GOVERNMENT WARNING",
        blocks: singleLineBlocks([
          { text: "GOVERNMENT", bbox: { x0: 0, y0: 0, x1: 100, y1: 20 }, confidence: 90 },
          { text: "WARNING:", bbox: { x0: 110, y0: 0, x1: 200, y1: 20 }, confidence: 88 },
        ]),
        confidence: 89,
      },
    });
    const out = await tesseractEngine.run(Buffer.from("x"));
    expect(out.words.map((w) => w.text)).toEqual(["GOVERNMENT", "WARNING:"]);
    expect(out.words[0]!.bbox.width).toBe(100);
    expect(out.words[1]!.bbox.x).toBe(110);
    expect(out.words[1]!.bbox.width).toBe(90);
  });

  it("returns an empty words array when Tesseract finds nothing", async () => {
    const { tesseractEngine } = await loadAdapterWithMock({
      data: {
        text: "",
        blocks: [],
        confidence: 0,
      },
    });
    const out = await tesseractEngine.run(Buffer.from("x"));
    expect(out.words).toEqual([]);
    expect(out.text).toBe("");
    expect(out.confidence).toBe(0);
  });

  it("returns an empty words array when Tesseract returns null blocks", async () => {
    const { tesseractEngine } = await loadAdapterWithMock({
      data: {
        text: "no words",
        blocks: null,
        confidence: 0,
      },
    });
    const out = await tesseractEngine.run(Buffer.from("x"));
    expect(out.words).toEqual([]);
  });
});

describe("tesseractEngine.run — defensive `is_bold` typing", () => {
  it("preserves `is_bold: true` as fontBold: true", async () => {
    const { tesseractEngine } = await loadAdapterWithMock({
      data: {
        text: "BOLD",
        blocks: singleLineBlocks([
          {
            text: "BOLD",
            bbox: { x0: 0, y0: 0, x1: 50, y1: 20 },
            confidence: 90,
            is_bold: true,
          },
        ]),
        confidence: 90,
      },
    });
    const out = await tesseractEngine.run(Buffer.from("x"));
    expect(out.words[0]?.fontBold).toBe(true);
  });

  it("preserves `is_bold: false` as fontBold: false", async () => {
    const { tesseractEngine } = await loadAdapterWithMock({
      data: {
        text: "thin",
        blocks: singleLineBlocks([
          {
            text: "thin",
            bbox: { x0: 0, y0: 0, x1: 50, y1: 20 },
            confidence: 90,
            is_bold: false,
          },
        ]),
        confidence: 90,
      },
    });
    const out = await tesseractEngine.run(Buffer.from("x"));
    expect(out.words[0]?.fontBold).toBe(false);
  });

  it("maps `is_bold: undefined` → fontBold: undefined (engine didn't tell us)", async () => {
    const { tesseractEngine } = await loadAdapterWithMock({
      data: {
        text: "x",
        blocks: singleLineBlocks([
          {
            text: "x",
            bbox: { x0: 0, y0: 0, x1: 10, y1: 10 },
            confidence: 90,
            // is_bold omitted
          },
        ]),
        confidence: 90,
      },
    });
    const out = await tesseractEngine.run(Buffer.from("x"));
    expect(out.words[0]?.fontBold).toBeUndefined();
  });

  it("DEFENDS AGAINST non-boolean is_bold values (string/number/null) → fontBold: undefined", async () => {
    // Older / different Tesseract builds have been observed to ship
    // is_bold as 0/1 or as a string. The adapter's type guard
    // intentionally narrows to `typeof === "boolean"` so we don't
    // silently treat truthy non-booleans as bold.
    for (const bad of [1, 0, "true", "false", null, "yes"]) {
      const { tesseractEngine } = await loadAdapterWithMock({
        data: {
          text: "x",
          blocks: singleLineBlocks([
            {
              text: "x",
              bbox: { x0: 0, y0: 0, x1: 10, y1: 10 },
              confidence: 90,
              is_bold: bad,
            },
          ]),
          confidence: 90,
        },
      });
      const out = await tesseractEngine.run(Buffer.from("x"));
      expect(out.words[0]?.fontBold).toBeUndefined();
    }
  });
});

describe("tesseractEngine.run — abort signal", () => {
  it("throws AbortError (DOMException) if signal is already aborted at call time", async () => {
    const { tesseractEngine } = await loadAdapterWithMock({
      data: {
        text: "x",
        blocks: [],
        confidence: 0,
      },
    });
    const ac = new AbortController();
    ac.abort();
    await expect(
      tesseractEngine.run(Buffer.from("x"), ac.signal),
    ).rejects.toThrow(/aborted/i);
  });

  it("does NOT throw when signal is provided but not aborted", async () => {
    const { tesseractEngine } = await loadAdapterWithMock({
      data: {
        text: "x",
        blocks: [],
        confidence: 0,
      },
    });
    const ac = new AbortController();
    const out = await tesseractEngine.run(Buffer.from("x"), ac.signal);
    expect(out).toBeDefined();
    expect(out.engine).toBe("tesseract");
  });
});

describe("tesseractEngine.run — overall result shape", () => {
  it("includes engine='tesseract', latencyMs, and top-level confidence (scaled /100)", async () => {
    const { tesseractEngine } = await loadAdapterWithMock({
      data: {
        text: "hello",
        blocks: singleLineBlocks([
          {
            text: "hello",
            bbox: { x0: 0, y0: 0, x1: 50, y1: 20 },
            confidence: 85,
          },
        ]),
        confidence: 85,
      },
    });
    const out = await tesseractEngine.run(Buffer.from("x"));
    expect(out.engine).toBe("tesseract");
    expect(typeof out.latencyMs).toBe("number");
    expect(out.latencyMs).toBeGreaterThanOrEqual(0);
    expect(out.confidence).toBeCloseTo(0.85, 2);
    expect(out.text).toBe("hello");
  });
});

describe("tesseractEngine.run — worker reuse across calls", () => {
  it("subsequent run() calls reuse the same worker (singleton via workerPromise)", async () => {
    // Confirm by inspecting `createWorker`'s call count on the mock.
    vi.resetModules();
    const createWorker = vi.fn(async () => ({
      async recognize() {
        return {
          data: { text: "", blocks: [], confidence: 0 },
        };
      },
    }));
    vi.doMock("tesseract.js", () => ({ createWorker }));
    const { tesseractEngine } = await import("@/lib/ocr/tesseract");
    await tesseractEngine.run(Buffer.from("a"));
    await tesseractEngine.run(Buffer.from("b"));
    await tesseractEngine.run(Buffer.from("c"));
    // Worker is created exactly once; the three run() calls share it.
    expect(createWorker).toHaveBeenCalledTimes(1);
  });
});

describe("warmupTesseract — eager worker init", () => {
  it("calling warmupTesseract triggers createWorker without invoking recognize", async () => {
    vi.resetModules();
    const recognizeSpy = vi.fn(async () => ({
      data: { text: "", blocks: [], confidence: 0 },
    }));
    const createWorker = vi.fn(async () => ({ recognize: recognizeSpy }));
    vi.doMock("tesseract.js", () => ({ createWorker }));
    const { warmupTesseract } = await import("@/lib/ocr/tesseract");
    await warmupTesseract();
    expect(createWorker).toHaveBeenCalledTimes(1);
    expect(recognizeSpy).not.toHaveBeenCalled();
  });
});
