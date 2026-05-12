// DOCX application parser.
//
// COLA applicants sometimes ship the application as a Word document.
// `mammoth` extracts the document body as plain text (rejecting style
// markup), and we feed the resulting text into the same
// `parseApplicationText` pipeline the .txt / .md path uses. Confidence
// is "medium" — the underlying text is reliable but the structured-
// field extraction is regex-based on the rendered text, same as the
// PDF-text path.

import mammoth from "mammoth";
import { parseApplicationText } from "./parse-text";
import type { ApplicationParseResult } from "./types";
import { ApplicationParseError } from "./types";

export async function parseApplicationDocx(
  buffer: Buffer,
): Promise<ApplicationParseResult> {
  let text: string;
  try {
    const out = await mammoth.extractRawText({ buffer });
    text = out.value ?? "";
  } catch (err) {
    throw new ApplicationParseError(
      "parse-failed",
      `DOCX parse failed: ${(err as Error).message}`,
    );
  }
  if (!text.trim()) {
    throw new ApplicationParseError(
      "parse-failed",
      "DOCX has no extractable text. Re-upload as PDF or fill in manually.",
    );
  }
  const parsed = parseApplicationText(text);
  return {
    fields: parsed.fields,
    source: "docx",
    warnings: parsed.warnings,
    confidence: "medium",
  };
}
