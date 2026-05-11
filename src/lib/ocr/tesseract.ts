import { createWorker, type Worker } from "tesseract.js";
import type { OcrEngine, OcrResult, OcrWord } from "./index";

/**
 * Lazy-loaded Tesseract worker. The first call pays the WASM warmup tax
 * (~1–1.8s on a Vercel function); subsequent calls share the warm worker.
 * `/api/warmup` hits this so the user does not pay the tax mid-verify.
 */
let workerPromise: Promise<Worker> | null = null;

async function getWorker(): Promise<Worker> {
  if (!workerPromise) {
    workerPromise = (async () => {
      const w = await createWorker("eng", undefined, {
        // Tesseract worker logs are noisy; suppress in prod by default.
        logger: () => undefined,
      });
      return w;
    })();
  }
  return workerPromise;
}

export const tesseractEngine: OcrEngine = {
  id: "tesseract",
  async run(image: Buffer, signal?: AbortSignal): Promise<OcrResult> {
    const start = performance.now();
    if (signal?.aborted) {
      throw new DOMException("aborted", "AbortError");
    }
    const worker = await getWorker();
    const result = await worker.recognize(image);
    const data = result.data;

    const words: OcrWord[] = (data.words ?? []).map((w) => ({
      text: w.text,
      bbox: {
        x: w.bbox.x0,
        y: w.bbox.y0,
        width: w.bbox.x1 - w.bbox.x0,
        height: w.bbox.y1 - w.bbox.y0,
      },
      confidence: w.confidence / 100,
    }));

    return {
      text: data.text,
      words,
      confidence: data.confidence / 100,
      latencyMs: performance.now() - start,
      engine: "tesseract",
    };
  },
};

/** Eagerly initialize the Tesseract worker — used by `/api/warmup`. */
export async function warmupTesseract(): Promise<void> {
  await getWorker();
}
