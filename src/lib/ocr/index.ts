// OCR adapters. Implementations land in Phase 3 of TODO.md.
// Shared interface so callers can swap engines (Tesseract today; PaddleOCR
// or others would slot in without changing call sites).
//
// Bounding boxes are non-optional: the Government Warning bold-detection
// pipeline needs the prefix bbox to crop and measure stroke width
// (see lib/validation/government-warning.ts and ARCHITECTURE.md §3 step 5).

export interface OcrWord {
  text: string;
  bbox: { x: number; y: number; width: number; height: number };
  confidence: number;
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
