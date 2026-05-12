import type { DeclaredFields } from "@/lib/types";
import {
  ApplicationParseError,
  type ApplicationParseResult,
} from "./types";
import { parseApplicationText } from "./parse-text";
import { parseApplicationJson, parseApplicationCsv } from "./parse-structured";
import { parseApplicationDocx } from "./parse-docx";
import { extractPdfFirstPage, extractPdfText } from "@/lib/pdf";
import { parseApplicationImage } from "./parse-image";

// ─── Application-document parsing entry point ──────────────────────────────
//
// Single dispatcher that the API route calls. Picks a parser by MIME type
// or file extension (extension wins when MIME is generic like
// "application/octet-stream"), runs it, and returns an ApplicationParseResult.
//
// What it does NOT do:
//   - Image vision — the path is sketched as an `image-vision` source but
//     calling the extractor lives in the API route, so it can pick the
//     single production vision path without coupling this
//     module to the vision adapters.

export const MAX_APPLICATION_BYTES = 10 * 1024 * 1024;

interface ParseArgs {
  buffer: Buffer;
  filename: string;
  mime: string;
  /**
   * Optional Google API key for the vision fallback. When provided
   * and a PDF has no extractable text (scanned PDF), the first page
   * is rendered to PNG and parsed via Gemini Vision rather than
   * failing closed. Without the key, the scanned-PDF case errors
   * with a "re-upload as image" message (current behaviour).
   */
  apiKey?: string;
}

export async function parseApplication(
  args: ParseArgs,
): Promise<ApplicationParseResult> {
  if (args.buffer.byteLength === 0) {
    throw new ApplicationParseError("empty", "Application file is empty.");
  }
  if (args.buffer.byteLength > MAX_APPLICATION_BYTES) {
    throw new ApplicationParseError(
      "too-large",
      `Application file exceeds ${MAX_APPLICATION_BYTES} bytes.`,
      413,
    );
  }

  const ext = extOf(args.filename);
  const mime = (args.mime ?? "").toLowerCase();

  // PDF — text-only extraction; the rendered image path is for label
  // images, not application documents.
  if (mime === "application/pdf" || ext === "pdf") {
    let text: string;
    try {
      const out = await extractPdfText(args.buffer);
      text = out.text;
    } catch (err) {
      throw new ApplicationParseError(
        "parse-failed",
        `PDF parse failed: ${(err as Error).message}`,
      );
    }
    if (!text.trim()) {
      // PDF with no extractable text — usually a scanned image.
      // Auto-fallback to vision if an API key is wired: render the
      // first page to PNG and run it through the same vision parser
      // the explicit image-of-application path uses. This is the
      // common real-world TTB submission case (printed and re-
      // scanned forms). Without an API key, surface the same error
      // as before so the operator knows to wire one or re-upload.
      if (!args.apiKey) {
        throw new ApplicationParseError(
          "parse-failed",
          "PDF has no extractable text (it may be a scanned image). Configure GOOGLE_API_KEY to enable the vision fallback, re-upload as an image, or fill in manually.",
        );
      }
      try {
        const rendered = await extractPdfFirstPage(args.buffer);
        const visionOut = await parseApplicationImage(
          rendered.pngBuffer,
          "image/png",
          { apiKey: args.apiKey },
        );
        return {
          fields: visionOut.fields,
          source: "pdf-vision-fallback",
          warnings: [
            "PDF had no extractable text — fell back to vision OCR of the rendered first page. Verify the extracted fields.",
            ...visionOut.warnings,
          ],
          confidence: "low",
        };
      } catch (err) {
        throw new ApplicationParseError(
          "parse-failed",
          `PDF has no extractable text and the vision fallback failed: ${(err as Error).message}`,
        );
      }
    }
    const parsed = parseApplicationText(text);
    return {
      fields: parsed.fields,
      source: "pdf-text",
      warnings: parsed.warnings,
      confidence: "medium",
    };
  }

  // JSON — structured.
  if (
    mime === "application/json" ||
    mime === "text/json" ||
    ext === "json"
  ) {
    const text = args.buffer.toString("utf8");
    try {
      const parsed = parseApplicationJson(text);
      return {
        fields: parsed.fields,
        source: "json",
        warnings: parsed.warnings,
        confidence: "high",
      };
    } catch (err) {
      throw new ApplicationParseError(
        "parse-failed",
        `JSON parse failed: ${(err as Error).message}`,
      );
    }
  }

  // DOCX — Word document. mammoth extracts rendered text, fed into
  // the same regex pipeline as the .txt / .md path.
  if (
    mime ===
      "application/vnd.openxmlformats-officedocument.wordprocessingml.document" ||
    ext === "docx"
  ) {
    return await parseApplicationDocx(args.buffer);
  }

  // CSV — structured.
  if (
    mime === "text/csv" ||
    mime === "application/csv" ||
    ext === "csv" ||
    ext === "tsv"
  ) {
    const text = args.buffer.toString("utf8");
    try {
      const parsed = parseApplicationCsv(text);
      return {
        fields: parsed.fields,
        source: "csv",
        warnings: parsed.warnings,
        confidence: "high",
      };
    } catch (err) {
      throw new ApplicationParseError(
        "parse-failed",
        `CSV parse failed: ${(err as Error).message}`,
      );
    }
  }

  // Markdown.
  if (
    mime === "text/markdown" ||
    mime === "text/x-markdown" ||
    ext === "md" ||
    ext === "markdown"
  ) {
    const text = args.buffer.toString("utf8");
    const parsed = parseApplicationText(text);
    return {
      fields: parsed.fields,
      source: "md",
      warnings: parsed.warnings,
      confidence: "medium",
    };
  }

  // Plain text — last text-format catch-all.
  if (
    mime.startsWith("text/") ||
    mime === "application/octet-stream" ||
    ext === "txt"
  ) {
    const text = args.buffer.toString("utf8");
    const parsed = parseApplicationText(text);
    return {
      fields: parsed.fields,
      source: "txt",
      warnings: parsed.warnings,
      confidence: "medium",
    };
  }

  // (DOCX handled above by parseApplicationDocx — earlier dispatch.)

  // Image — caller (the API route) handles the vision path so this
  // module stays free of the vision-adapter import surface.
  if (mime.startsWith("image/")) {
    throw new ApplicationParseError(
      "vision-unavailable",
      "Application-from-image parsing must be routed through the vision path. The route handler should call parseApplicationImage() directly.",
      400,
    );
  }

  throw new ApplicationParseError(
    "unsupported-mime",
    `Unsupported application-document type "${mime || "(none)"}" / ".${ext}". Accepts PDF, JSON, CSV, MD, TXT, or image.`,
    415,
  );
}

function extOf(filename: string): string {
  const base = filename.split(/[\\/]/).pop() ?? filename;
  const dot = base.lastIndexOf(".");
  if (dot <= 0) return "";
  return base.slice(dot + 1).toLowerCase();
}

// Re-export the parse-text helper so the API route can call it directly
// when it has already extracted text via vision-OCR on an image.
export { parseApplicationText };
export type { ApplicationParseResult } from "./types";
export { ApplicationParseError } from "./types";

// The DeclaredFields type is re-exported for the API route's response shaping.
export type { DeclaredFields };
