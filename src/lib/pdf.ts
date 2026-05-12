// PDF input handling for /api/verify.
//
// Why this lives in its own module: the JPEG/PNG/WebP path goes straight to
// `sharp` + `verifyLabel`, but PDF needs a rasterization step first. We extract
// the first page of a PDF and hand a PNG buffer to the existing pipeline so
// downstream code (`preprocess.ts`, `verify.ts`) doesn't care that the input
// originated as a PDF.
//
// Approach — DEGRADED TEXT-OVERLAY RENDER (documented for parent agent):
// True PDF rasterization in pure-Node requires either the native `canvas`
// package (not installed here, and brings system-library headaches on Vercel)
// or pdfjs-dist's own DOM polyfills (which expect a browser environment). For
// this prototype we instead use pdfjs-dist's worker-free legacy build to parse
// the PDF and pull its first page's text content via `getTextContent`, then
// composite that text onto a blank white canvas with `sharp` + an SVG overlay.
// The resulting PNG is visually unlike the source PDF but contains the same
// textual signal the vision model needs to verify label fields. Perfect visual
// fidelity is explicitly out-of-scope per the task spec.
//
// If/when `canvas` (or @napi-rs/canvas) is added as a dependency, swap the
// `renderPageToPng` body for a true `page.render({ canvasContext, viewport })`
// call. The public API (`extractPdfFirstPage`) stays the same.

import sharp from "sharp";

export const MAX_PDF_BYTES = 20 * 1024 * 1024; // 20 MB
const RENDER_LONG_EDGE_PX = 1600;
// Roughly A4 portrait at ~120 DPI — close enough for any reasonable label PDF
// and keeps the synthetic image well under the long-edge target above.
const RENDER_WIDTH_PX = 1240;
const RENDER_HEIGHT_PX = 1600;

export type PdfExtractErrorCode =
  | "encrypted"
  | "empty"
  | "too-large"
  | "render-failed";

export class PdfExtractError extends Error {
  readonly code: PdfExtractErrorCode;
  constructor(code: PdfExtractErrorCode, message: string) {
    super(message);
    this.name = "PdfExtractError";
    this.code = code;
  }
}

export interface PdfExtractResult {
  pngBuffer: Buffer;
  pageCount: number;
}

/**
 * Extract the first page of a PDF as a PNG buffer suitable for the vision
 * pipeline. See module header for why this currently produces a synthesized
 * text-overlay image rather than a true rasterization.
 */
export async function extractPdfFirstPage(
  buffer: Buffer,
): Promise<PdfExtractResult> {
  if (buffer.byteLength > MAX_PDF_BYTES) {
    throw new PdfExtractError(
      "too-large",
      `PDF exceeds ${MAX_PDF_BYTES} bytes.`,
    );
  }

  // pdfjs-dist's published types are loose (`any`-heavy) at the legacy entry,
  // so we narrow at the boundary and avoid `any` past this point.
  const pdfjs = await loadPdfjs();

  // Copy to a fresh Uint8Array — pdfjs-dist takes ownership of the buffer
  // it's handed (it sets it to null after parsing) and Node Buffers are
  // views, so passing one directly can mutate other slices of the same
  // underlying ArrayBuffer.
  const data = new Uint8Array(buffer.byteLength);
  data.set(buffer);

  let doc: PdfDocumentLike;
  try {
    const loadingTask = pdfjs.getDocument({
      data,
      // No worker; render in the main thread. The legacy build supports this.
      disableFontFace: true,
      // We don't fetch standard fonts over the network in a serverless env.
      useSystemFonts: false,
      isEvalSupported: false,
    });
    doc = (await loadingTask.promise) as PdfDocumentLike;
  } catch (err) {
    const e = err as { name?: string; message?: string };
    if (e.name === "PasswordException") {
      throw new PdfExtractError(
        "encrypted",
        "PDF is password-protected.",
      );
    }
    throw new PdfExtractError(
      "render-failed",
      `Could not parse PDF: ${e.message ?? "unknown error"}`,
    );
  }

  const pageCount = doc.numPages;
  if (pageCount < 1) {
    throw new PdfExtractError("empty", "PDF has no pages.");
  }

  let pngBuffer: Buffer;
  try {
    const page = (await doc.getPage(1)) as PdfPageLike;
    const textContent = await page.getTextContent();
    const items = textContent.items.filter(isTextItem);
    pngBuffer = await renderTextToPng(items.map((it) => it.str));
  } catch (err) {
    const e = err as Error;
    throw new PdfExtractError(
      "render-failed",
      `Could not render first page: ${e.message}`,
    );
  } finally {
    // Free pdfjs worker resources (no-op for the legacy non-worker build, but
    // documented behavior; cheap insurance against future regressions).
    try {
      await doc.destroy();
    } catch {
      // ignore
    }
  }

  return { pngBuffer, pageCount };
}

/**
 * Compose extracted text strings onto a white PNG canvas via an SVG overlay.
 * Each item becomes one line — pdfjs's text items are already roughly
 * word/line-segment granularity, which is good enough for the vision model.
 */
async function renderTextToPng(lines: readonly string[]): Promise<Buffer> {
  // Trim and bound the visible text so a verbose PDF doesn't overflow the
  // canvas. We keep the first ~120 short-ish lines; that's plenty for any
  // realistic label / COLA artwork.
  const cleaned = lines
    .map((s) => s.replace(/\s+/g, " ").trim())
    .filter((s) => s.length > 0)
    .slice(0, 120);

  const lineHeight = 28;
  const left = 40;
  const top = 60;

  const tspans = cleaned
    .map((line, idx) => {
      const y = top + idx * lineHeight;
      // Defensive XML escape — pdf text content can contain &, <, > etc.
      const safe = line
        .replace(/&/g, "&amp;")
        .replace(/</g, "&lt;")
        .replace(/>/g, "&gt;")
        .slice(0, 200);
      return `<text x="${left}" y="${y}" font-family="Helvetica, Arial, sans-serif" font-size="20" fill="#111">${safe}</text>`;
    })
    .join("\n");

  const svg = `<?xml version="1.0" encoding="UTF-8"?>
<svg xmlns="http://www.w3.org/2000/svg" width="${RENDER_WIDTH_PX}" height="${RENDER_HEIGHT_PX}">
  <rect width="100%" height="100%" fill="#ffffff"/>
  ${tspans}
</svg>`;

  // Ensure the result respects the long-edge target documented in the
  // module header, even though our canvas dims already do.
  return sharp(Buffer.from(svg))
    .resize({
      width:
        RENDER_WIDTH_PX >= RENDER_HEIGHT_PX ? RENDER_LONG_EDGE_PX : undefined,
      height:
        RENDER_HEIGHT_PX > RENDER_WIDTH_PX ? RENDER_LONG_EDGE_PX : undefined,
      withoutEnlargement: true,
    })
    .png()
    .toBuffer();
}

// ─── pdfjs-dist type narrowing ───────────────────────────────────────────────
// The package's legacy entry re-exports everything from "pdfjs-dist" but its
// published .d.ts shapes are heavy on `any`. We define minimal structural
// interfaces here so the rest of the file is strict-clean.

interface PdfTextItemLike {
  str: string;
  // there are other fields (dir, transform, etc.) but we only need str
}

function isTextItem(it: unknown): it is PdfTextItemLike {
  return (
    typeof it === "object" &&
    it !== null &&
    "str" in it &&
    typeof (it as { str: unknown }).str === "string"
  );
}

interface PdfTextContentLike {
  items: unknown[];
}

interface PdfPageLike {
  getTextContent(): Promise<PdfTextContentLike>;
}

interface PdfDocumentLike {
  numPages: number;
  getPage(n: number): Promise<unknown>;
  destroy(): Promise<void>;
}

interface PdfjsModule {
  // The real signature has many options; we only pass what we need.
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  getDocument(src: { data: Uint8Array } & Record<string, unknown>): {
    promise: Promise<unknown>;
  };
}

let cached: PdfjsModule | null = null;
async function loadPdfjs(): Promise<PdfjsModule> {
  if (cached) return cached;
  // pdfjs-dist's legacy build ships ESM that works in Node without a Web
  // Worker. The default build assumes browser globals.
  // We cast to `unknown` first to escape the upstream `any`-typed surface
  // (intentional: pdfjs's published types don't model the legacy entry well).
  const mod = (await import("pdfjs-dist/legacy/build/pdf.mjs")) as unknown as PdfjsModule;
  cached = mod;
  return mod;
}
