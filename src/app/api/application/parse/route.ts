import { NextResponse } from "next/server";
import {
  parseApplication,
  ApplicationParseError,
  MAX_APPLICATION_BYTES,
  type ApplicationParseResult,
} from "@/lib/application/parse";
import { parseApplicationImage } from "@/lib/application/parse-image";

export const runtime = "nodejs";
export const maxDuration = 60;

const ACCEPTED_IMAGE_MIME = new Set([
  "image/jpeg",
  "image/jpg",
  "image/png",
  "image/webp",
  "image/heic",
  "image/heif",
]);

/**
 * POST /api/application/parse
 *
 * Body: multipart/form-data with one field `file` (PDF, JSON, CSV, MD,
 * TXT, or image). Returns:
 *
 *   200 {
 *     fields:     Partial<DeclaredFields>,
 *     source:     "txt" | "md" | "json" | "csv" | "pdf-text" | "image-vision",
 *     warnings:   string[],
 *     confidence: "high" | "medium" | "low"
 *   }
 *
 * Errors return the canonical `{ error, code }` shape. The route is
 * stateless — it does NOT enqueue a verification; the client takes the
 * parsed fields, lets the reviewer confirm/edit, then POSTs to
 * /api/verify like any manual entry would.
 */
export async function POST(req: Request) {
  let form: FormData;
  try {
    form = await req.formData();
  } catch {
    return NextResponse.json(
      { error: "Body must be multipart/form-data.", code: "bad-request" },
      { status: 400 },
    );
  }

  const fileEntry = form.get("file");
  if (!(fileEntry instanceof File)) {
    return NextResponse.json(
      { error: "Missing 'file' field.", code: "missing-file" },
      { status: 400 },
    );
  }
  if (fileEntry.size === 0) {
    return NextResponse.json(
      { error: "File is empty.", code: "empty" },
      { status: 400 },
    );
  }
  if (fileEntry.size > MAX_APPLICATION_BYTES) {
    return NextResponse.json(
      {
        error: `File exceeds ${MAX_APPLICATION_BYTES} bytes.`,
        code: "too-large",
      },
      { status: 413 },
    );
  }

  const buffer = Buffer.from(await fileEntry.arrayBuffer());
  const mime = (fileEntry.type || "").toLowerCase();
  const filename = fileEntry.name || "application";

  // Image-of-application path is handled separately because it needs the
  // Gemini key + a different prompt. Everything else routes through the
  // pure-text dispatcher in lib/application/parse.ts.
  if (mime.startsWith("image/") || ACCEPTED_IMAGE_MIME.has(mime)) {
    const apiKey = process.env.GOOGLE_API_KEY ?? "";
    if (!apiKey) {
      return NextResponse.json(
        {
          error:
            "Application-image parsing requires GOOGLE_API_KEY. Configure the server, or upload the application as PDF/JSON/CSV/MD/TXT, or fill the form in manually.",
          code: "vision-unavailable",
        },
        { status: 503 },
      );
    }
    try {
      const out = await parseApplicationImage(buffer, mime, { apiKey });
      const body: ApplicationParseResult = {
        fields: out.fields,
        source: "image-vision",
        warnings: out.warnings,
        confidence: "low",
      };
      return NextResponse.json(body);
    } catch (err) {
      return NextResponse.json(
        {
          error: `Image vision failed: ${(err as Error).message}`,
          code: "parse-failed",
        },
        { status: 502 },
      );
    }
  }

  try {
    const result = await parseApplication({ buffer, filename, mime });
    return NextResponse.json(result);
  } catch (err) {
    if (err instanceof ApplicationParseError) {
      return NextResponse.json(
        { error: err.message, code: err.code },
        { status: err.status },
      );
    }
    return NextResponse.json(
      {
        error: `Application parse failed: ${(err as Error).message}`,
        code: "parse-failed",
      },
      { status: 500 },
    );
  }
}
