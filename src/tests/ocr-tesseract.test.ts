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
    words: MockTesseractWord[];
    confidence: number;
  };
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
          async recognize(_image: Buffer) {
            if (recognizeOutput instanceof Error) throw recognizeOutput;
            return recognizeOutput;
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

describe("tesseractEngine.run — bbox conversion (x0/y0/x1/y1 → x/y/width/height)", () => {
  it("converts a single word's corner-form bbox to offset-form correctly", async () => {
    const { tesseractEngine } = await loadAdapterWithMock({
      data: {
        text: "GOVERNMENT",
        words: [
          {
            text: "GOVERNMENT",
            bbox: { x0: 10, y0: 20, x1: 110, y1: 50 },
            confidence: 92,
          },
        ],
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
        words: [
          { text: "GOVERNMENT", bbox: { x0: 0, y0: 0, x1: 100, y1: 20 }, confidence: 90 },
          { text: "WARNING:", bbox: { x0: 110, y0: 0, x1: 200, y1: 20 }, confidence: 88 },
        ],
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
        words: [],
        confidence: 0,
      },
    });
    const out = await tesseractEngine.run(Buffer.from("x"));
    expect(out.words).toEqual([]);
    expect(out.text).toBe("");
    expect(out.confidence).toBe(0);
  });

  it("handles missing words array defensively (`?? []`)", async () => {
    const { tesseractEngine } = await loadAdapterWithMock({
      data: {
        text: "no words",
        // `words` deliberately undefined — adapter must not crash
        words: undefined as unknown as MockTesseractWord[],
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
        words: [
          {
            text: "BOLD",
            bbox: { x0: 0, y0: 0, x1: 50, y1: 20 },
            confidence: 90,
            is_bold: true,
          },
        ],
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
        words: [
          {
            text: "thin",
            bbox: { x0: 0, y0: 0, x1: 50, y1: 20 },
            confidence: 90,
            is_bold: false,
          },
        ],
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
        words: [
          {
            text: "x",
            bbox: { x0: 0, y0: 0, x1: 10, y1: 10 },
            confidence: 90,
            // is_bold omitted
          },
        ],
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
          words: [
            {
              text: "x",
              bbox: { x0: 0, y0: 0, x1: 10, y1: 10 },
              confidence: 90,
              is_bold: bad,
            },
          ],
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
        words: [],
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
        words: [],
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
        words: [
          {
            text: "hello",
            bbox: { x0: 0, y0: 0, x1: 50, y1: 20 },
            confidence: 85,
          },
        ],
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
          data: { text: "", words: [], confidence: 0 },
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
      data: { text: "", words: [], confidence: 0 },
    }));
    const createWorker = vi.fn(async () => ({ recognize: recognizeSpy }));
    vi.doMock("tesseract.js", () => ({ createWorker }));
    const { warmupTesseract } = await import("@/lib/ocr/tesseract");
    await warmupTesseract();
    expect(createWorker).toHaveBeenCalledTimes(1);
    expect(recognizeSpy).not.toHaveBeenCalled();
  });
});
