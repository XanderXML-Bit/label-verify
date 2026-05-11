// OCR adapters. Implementations land in Phase 3 of TODO.md.
// Exports the shared OCR interface so callers can swap engines uniformly.

export interface OcrResult {
  text: string;
  confidence: number;
  latencyMs: number;
  engine: "tesseract" | "paddleocr";
}

export interface OcrEngine {
  readonly id: OcrResult["engine"];
  run(image: Buffer): Promise<OcrResult>;
}
