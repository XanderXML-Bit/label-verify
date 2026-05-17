// PDF input handling for /api/verify.
//
// True rasterization via @napi-rs/canvas (pure-Rust native binding,
// works on Vercel Linux without system libraries). pdfjs-dist's legacy
// build is fed a NodeCanvasFactory and renders the first page at a
// long-edge target so the vision model sees actual rendered glyphs
// with font weights — required for Gov Warning bold detection.
//
// Public API:
//   - extractPdfFirstPage(buf): rasterize page 1 to PNG
//   - extractPdfText(buf): text-only extraction (application document path)

import sharp from "sharp";

export const MAX_PDF_BYTES = 20 * 1024 * 1024; // 20 MB
// Wave-33 audit (Sub-agent A bug #4): match the wave-31j preprocess
// long-edge target (2000 px). Previously this was 1600 — the downstream
// preprocess step then Lanczos-upscaled to 2000, which is pure resampling
// noise on already-rasterized content. Native pdfjs rendering at the
// final target is sharper AND skips an unnecessary upsampling pass.
const RENDER_LONG_EDGE_PX = 2000;

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
 * Extract the first page of a PDF as a PNG buffer suitable for the
 * vision pipeline. Renders via pdfjs-dist + @napi-rs/canvas. The output
 * is a real raster of the PDF page (preserves font weights), so the Gov
 * Warning bold-detection subscore works on PDF uploads.
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

  const pdfjs = await loadPdfjs();
  const canvasMod = await loadCanvas();

  // pdfjs-dist takes ownership of the buffer it's handed (sets it to
  // null after parsing). Node Buffers are views — passing one directly
  // can mutate other slices of the same underlying ArrayBuffer.
  const data = new Uint8Array(buffer.byteLength);
  data.set(buffer);

  let doc: PdfDocumentLike;
  try {
    const loadingTask = pdfjs.getDocument({
      data,
      disableFontFace: true,
      useSystemFonts: false,
      isEvalSupported: false,
      // Required so pdfjs uses the supplied canvasFactory rather than
      // assuming browser globals.
      canvasFactory: new NodeCanvasFactory(canvasMod),
    });
    doc = (await loadingTask.promise) as PdfDocumentLike;
  } catch (err) {
    const e = err as { name?: string; message?: string };
    if (e.name === "PasswordException") {
      throw new PdfExtractError("encrypted", "PDF is password-protected.");
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
    // Scale so the long edge hits RENDER_LONG_EDGE_PX. pdfjs's default
    // viewport is at "scale: 1" = 72 DPI; we boost to roughly 144-200
    // DPI depending on page geometry.
    const baseViewport = page.getViewport({ scale: 1 });
    const longEdge = Math.max(baseViewport.width, baseViewport.height);
    const scale = longEdge > 0 ? RENDER_LONG_EDGE_PX / longEdge : 2;
    const viewport = page.getViewport({ scale });

    const factory = new NodeCanvasFactory(canvasMod);
    const ctx = factory.create(viewport.width, viewport.height);
    await page.render({
      canvasContext: ctx.context as unknown as object,
      viewport,
      canvas: ctx.canvas as unknown as object,
    }).promise;

    const raw = (ctx.canvas as { toBuffer: (mime: string) => Buffer }).toBuffer(
      "image/png",
    );
    // Round-trip through sharp so we normalise the PNG (strip metadata)
    // and downstream preprocessing has the exact same shape it gets
    // from JPEG/PNG/WebP uploads.
    pngBuffer = await sharp(raw).png().toBuffer();
  } catch (err) {
    const e = err as Error;
    throw new PdfExtractError(
      "render-failed",
      `Could not render first page: ${e.message}`,
    );
  } finally {
    try {
      await doc.destroy();
    } catch {
      // ignore
    }
  }

  return { pngBuffer, pageCount };
}

// ─── pdfjs-dist canvasFactory adapter ──────────────────────────────────────

interface CanvasMod {
  createCanvas(w: number, h: number): unknown;
}

interface CanvasContext {
  canvas: unknown;
  context: unknown;
}

class NodeCanvasFactory {
  constructor(private readonly mod: CanvasMod) {}
  create(width: number, height: number): CanvasContext {
    const w = Math.max(1, Math.floor(width));
    const h = Math.max(1, Math.floor(height));
    const canvas = this.mod.createCanvas(w, h) as {
      getContext: (t: string) => unknown;
    };
    const context = canvas.getContext("2d");
    return { canvas, context };
  }
  reset(ctx: CanvasContext, width: number, height: number): void {
    const c = ctx.canvas as { width: number; height: number };
    c.width = Math.max(1, Math.floor(width));
    c.height = Math.max(1, Math.floor(height));
  }
  destroy(ctx: CanvasContext): void {
    const c = ctx.canvas as { width: number; height: number };
    c.width = 0;
    c.height = 0;
  }
}

// ─── pdfjs-dist type narrowing ───────────────────────────────────────────────

interface PdfTextItemLike {
  str: string;
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

interface PdfViewportLike {
  width: number;
  height: number;
}

interface PdfRenderTaskLike {
  promise: Promise<void>;
}

interface PdfPageLike {
  getTextContent(): Promise<PdfTextContentLike>;
  getViewport(opts: { scale: number }): PdfViewportLike;
  render(params: {
    canvasContext: object;
    viewport: PdfViewportLike;
    canvas?: object;
  }): PdfRenderTaskLike;
}

interface PdfDocumentLike {
  numPages: number;
  getPage(n: number): Promise<unknown>;
  destroy(): Promise<void>;
}

interface PdfjsModule {
  getDocument(
    src: { data: Uint8Array } & Record<string, unknown>,
  ): { promise: Promise<unknown> };
}

// ─── Public: text-only extraction (application-document path) ──────────────

export interface PdfTextResult {
  text: string;
  pageCount: number;
}

export async function extractPdfText(buffer: Buffer): Promise<PdfTextResult> {
  if (buffer.byteLength > MAX_PDF_BYTES) {
    throw new PdfExtractError(
      "too-large",
      `PDF exceeds ${MAX_PDF_BYTES} bytes.`,
    );
  }
  const pdfjs = await loadPdfjs();
  const data = new Uint8Array(buffer.byteLength);
  data.set(buffer);
  let doc: PdfDocumentLike;
  try {
    const loadingTask = pdfjs.getDocument({
      data,
      disableFontFace: true,
      useSystemFonts: false,
      isEvalSupported: false,
    });
    doc = (await loadingTask.promise) as PdfDocumentLike;
  } catch (err) {
    const e = err as { name?: string; message?: string };
    if (e.name === "PasswordException") {
      throw new PdfExtractError("encrypted", "PDF is password-protected.");
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
  const pagesToRead = Math.min(pageCount, 20);
  const blocks: string[] = [];
  try {
    for (let i = 1; i <= pagesToRead; i++) {
      const page = (await doc.getPage(i)) as PdfPageLike;
      const tc = await page.getTextContent();
      const items = tc.items.filter(isTextItem);
      const pageText = items
        .map((it) => it.str)
        .filter((s) => s.length > 0)
        .join("\n");
      blocks.push(pageText);
    }
  } catch (err) {
    throw new PdfExtractError(
      "render-failed",
      `Could not extract text: ${(err as Error).message}`,
    );
  } finally {
    try {
      await doc.destroy();
    } catch {
      // ignore
    }
  }
  return { text: blocks.join("\n\n"), pageCount };
}

let cachedPdfjs: PdfjsModule | null = null;
async function loadPdfjs(): Promise<PdfjsModule> {
  if (cachedPdfjs) return cachedPdfjs;
  const mod = (await import("pdfjs-dist/legacy/build/pdf.mjs")) as unknown as PdfjsModule;
  cachedPdfjs = mod;
  return mod;
}

let cachedCanvas: CanvasMod | null = null;
async function loadCanvas(): Promise<CanvasMod> {
  if (cachedCanvas) return cachedCanvas;
  const mod = (await import("@napi-rs/canvas")) as unknown as CanvasMod;
  cachedCanvas = mod;
  return mod;
}
