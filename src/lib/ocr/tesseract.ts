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
    const { data } = await worker.recognize(image, {}, { blocks: true });

    const recognizedWords = (data.blocks ?? []).flatMap((block) =>
      block.paragraphs.flatMap((paragraph) =>
        paragraph.lines.flatMap((line) => line.words),
      ),
    );
    const words: OcrWord[] = recognizedWords.map((word) => {
      // Missing bold metadata lets the validator estimate bold from stroke width.
      const fontBold =
        "is_bold" in word && typeof word.is_bold === "boolean"
          ? word.is_bold
          : undefined;
      return {
        text: word.text,
        bbox: {
          x: word.bbox.x0,
          y: word.bbox.y0,
          width: word.bbox.x1 - word.bbox.x0,
          height: word.bbox.y1 - word.bbox.y0,
        },
        confidence: word.confidence / 100,
        fontBold,
      };
    });

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
