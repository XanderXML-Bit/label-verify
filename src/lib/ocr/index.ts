// OCR adapters. Shared interface so callers can swap engines (Tesseract
// today; PaddleOCR or others would slot in without changing call sites).
//
// Bounding boxes are non-optional: the Government Warning bold-detection
// pipeline needs the prefix bbox to crop and measure stroke width
// (see lib/validation/government-warning.ts and ARCHITECTURE.md §3 step 5).

export interface OcrWord {
  text: string;
  bbox: { x: number; y: number; width: number; height: number };
  confidence: number;
  /**
   * Tesseract's font-attribute classifier flag for "bold" weight on this
   * word, when the engine emits it. Most builds of tesseract.js DO expose
   * `is_bold` per word (see node_modules/tesseract.js/src/index.d.ts),
   * but it's unreliable on synthetic crops and tiny text — treat it as
   * a corroboration signal, never the only signal. `undefined` when the
   * engine didn't emit it.
   */
  fontBold?: boolean;
}

export interface OcrResult {
  text: string;
  words: OcrWord[];
  confidence: number;
  latencyMs: number;
  engine: "tesseract" | "paddleocr";
}

export interface OcrEngine {
  readonly id: OcrResult["engine"];
  run(image: Buffer, signal?: AbortSignal): Promise<OcrResult>;
}
