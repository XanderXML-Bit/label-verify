import { NextResponse } from "next/server";
import {
  parseApplication,
  ApplicationParseError,
  MAX_APPLICATION_BYTES,
  type ApplicationParseResult,
} from "@/lib/application/parse";
import { parseApplicationImage } from "@/lib/application/parse-image";
import { callerKey, rateLimit } from "@/lib/rate-limit";

export const runtime = "nodejs";
export const maxDuration = 60;

// REMAINING-IMPROVEMENTS R4: separately bucket per-IP for this
// endpoint so abuse of the image-of-application path (which calls
// Gemini and bills us) can't piggyback on the user's /api/verify
// budget. Default 60/min — same as /api/verify. The bucket key is
// `app-parse:` prefixed so it's a distinct bucket per endpoint.
const RATE_LIMIT_PER_MIN = Number(process.env.RATE_LIMIT_PER_MIN ?? 60);

// Strict allowlist — only formats Gemini's vision API will accept. We do
// NOT pass arbitrary "image/*" through; an SVG buffer rewritten to JPEG
// (per the previous lax allowlist) would either trip Gemini's content
// filter or, worse, be rendered server-side and become an XSS / SSRF
// vector if surfaced anywhere. Reject early, surface 415 to the caller.
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
  const key = callerKey(req.headers);
  const rl = rateLimit(`app-parse:${key}`, { perMinute: RATE_LIMIT_PER_MIN });
  if (!rl.allowed) {
    return NextResponse.json(
      {
        error: `Rate limit exceeded. Try again in ${rl.resetSeconds}s.`,
        code: "rate-limited",
      },
      {
        status: 429,
        headers: {
          "Retry-After": String(rl.resetSeconds),
          "X-RateLimit-Remaining": "0",
        },
      },
    );
  }

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
  // Optional: caller can pass the image filename it's verifying so the
  // parser can pick the matching row out of a multi-row manifest
  // (filename-keyed JSON object, `filename`-column CSV, etc.). Without
  // it, the multi-row case falls back to the first row + a warning.
  const imageFilenameRaw = form.get("imageFilename");
  const imageFilename =
    typeof imageFilenameRaw === "string" && imageFilenameRaw.trim()
      ? imageFilenameRaw.trim()
      : undefined;

  // Image-of-application path is handled separately because it needs the
  // Gemini key + a different prompt. We require an EXACT MIME match
  // against the Gemini-supported set — `image/svg+xml`, `image/gif`,
  // `image/bmp`, etc., are 415'd rather than rewritten to JPEG and sent
  // upstream (per security code review 2026-05).
  if (ACCEPTED_IMAGE_MIME.has(mime)) {
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
      return NextResponse.json(body, {
        headers: { "X-RateLimit-Remaining": String(rl.remaining) },
      });
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
    const result = await parseApplication({
      buffer,
      filename,
      mime,
      // Wire the Google API key so the PDF-without-text path can
      // fall back to vision OCR of the rendered first page instead
      // of failing closed. parseApplication ignores the key on
      // non-PDF paths.
      ...(process.env.GOOGLE_API_KEY
        ? { apiKey: process.env.GOOGLE_API_KEY }
        : {}),
      ...(imageFilename ? { imageFilename } : {}),
    });
    return NextResponse.json(result, {
      headers: { "X-RateLimit-Remaining": String(rl.remaining) },
    });
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
