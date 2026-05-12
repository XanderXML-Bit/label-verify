import type { DeclaredFields } from "@/lib/types";

// ─── Application-document parsing types ────────────────────────────────────
//
// What the reviewer hands us as "application data" — the COLA applicant's
// declared values, in whatever file the agency stored them. This sits
// alongside the label image and tells the verifier what the image SHOULD
// say. Free-form text formats (TXT/MD) get regex-extracted; structured
// formats (JSON/CSV) go through the same row→DeclaredFields shim the
// batch route already uses; PDFs go through pdfjs-dist text extraction;
// images go through the bake-off-winning vision model.
//
// Every parser returns the same Result shape so the API route and the UI
// can treat them uniformly:
//   - `fields`     : the partially-filled DeclaredFields (any field may
//                    be missing — the form lets the reviewer top up).
//   - `source`     : short identifier for the parser path that produced
//                    the fields, e.g. "txt", "pdf-text", "image-vision".
//   - `warnings`   : non-fatal issues to surface to the reviewer (e.g.
//                    "ABV not found — please enter manually").
//   - `confidence` : the parser's self-assessment ("high" = exact match,
//                    "medium" = regex parse with no ambiguity, "low" =
//                    AI-inferred or PDF render-quality dependent).

export type ApplicationParserSource =
  | "txt"
  | "md"
  | "json"
  | "csv"
  | "pdf-text"
  | "pdf-vision-fallback"
  | "docx"
  | "image-vision";

export type ApplicationConfidence = "high" | "medium" | "low";

export interface ApplicationParseResult {
  /** Partial because no parser is guaranteed to find all 7 fields. */
  fields: Partial<DeclaredFields>;
  source: ApplicationParserSource;
  warnings: string[];
  confidence: ApplicationConfidence;
}

// ─── Error type ─────────────────────────────────────────────────────────────

export class ApplicationParseError extends Error {
  readonly code:
    | "unsupported-mime"
    | "too-large"
    | "parse-failed"
    | "empty"
    | "vision-unavailable";
  readonly status: number;
  constructor(
    code: ApplicationParseError["code"],
    message: string,
    status = 400,
  ) {
    super(message);
    this.name = "ApplicationParseError";
    this.code = code;
    this.status = status;
  }
}
