import type { DeclaredFields } from "@/lib/types";
import {
  ApplicationParseError,
  type ApplicationParseResult,
} from "./types";
import { parseApplicationText } from "./parse-text";
import { parseApplicationJson, parseApplicationCsv } from "./parse-structured";
import { extractPdfText } from "@/lib/pdf";

// ─── Application-document parsing entry point ──────────────────────────────
//
// Single dispatcher that the API route calls. Picks a parser by MIME type
// or file extension (extension wins when MIME is generic like
// "application/octet-stream"), runs it, and returns an ApplicationParseResult.
//
// What it does NOT do (yet):
//   - DOCX — adds `mammoth` to the dep tree; deferred until a reviewer
//     hands us a DOCX they can't easily convert to PDF/text.
//   - Image vision — the path is sketched as an `image-vision` source but
//     calling the extractor lives in the API route, so it can pick the
//     single production vision path without coupling this
//     module to the vision adapters.

export const MAX_APPLICATION_BYTES = 10 * 1024 * 1024;

interface ParseArgs {
  buffer: Buffer;
  filename: string;
  mime: string;
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
      // PDF with no extractable text — usually a scanned image. Tell the
      // caller they can re-upload it as an image so the vision path picks
      // it up.
      throw new ApplicationParseError(
        "parse-failed",
        "PDF has no extractable text (it may be a scanned image). Re-upload as an image, or fill in manually.",
      );
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

  // DOCX (not yet wired) — tell the reviewer to convert.
  if (
    mime === "application/vnd.openxmlformats-officedocument.wordprocessingml.document" ||
    ext === "docx"
  ) {
    throw new ApplicationParseError(
      "unsupported-mime",
      "DOCX upload is not yet supported. Convert the file to PDF or paste the text directly.",
      415,
    );
  }

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
