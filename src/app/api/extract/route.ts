import { NextResponse } from "next/server";
import { extractOnly } from "@/lib/verify";
import { UrlFetchError, fetchUrlImage } from "@/lib/input-handlers";
import { callerKey, rateLimit } from "@/lib/rate-limit";
import {
  MAX_PDF_BYTES,
  PdfExtractError,
  extractPdfFirstPage,
} from "@/lib/pdf";

export const runtime = "nodejs";
export const maxDuration = 60;

// ─── /api/extract — label-only path (no application data) ─────────────────
//
// Mirrors /api/verify's input contract (multipart/form-data with `image`,
// or `url`) but does NOT require `declared`. Returns the extracted
// fields, image-quality flag, and a Government Warning subscore (the
// only check that is *self-contained* — federal regulation, not
// application-derived). UI surfaces a yellow "application data not
// provided" disclaimer over the result so the reviewer can't accidentally
// treat the extraction as a verification.

const PDF_MIME = "application/pdf";
const ACCEPTED_MIME = new Set([
  "image/jpeg",
  "image/png",
  "image/webp",
  "image/heic",
  "image/heif",
  PDF_MIME,
]);
const MAX_BYTES = 10 * 1024 * 1024;
const RATE_LIMIT_PER_MIN = Number(process.env.RATE_LIMIT_PER_MIN ?? 60);

export async function POST(req: Request) {
  const key = callerKey(req.headers);
  const rl = rateLimit(`extract:${key}`, { perMinute: RATE_LIMIT_PER_MIN });
  if (!rl.allowed) {
    return NextResponse.json(
      { error: `Rate limit exceeded. Try again in ${rl.resetSeconds}s.` },
      {
        status: 429,
        headers: {
          "Retry-After": String(rl.resetSeconds),
          "X-RateLimit-Remaining": "0",
        },
      },
    );
  }

  const contentType = req.headers.get("content-type") ?? "";

  // JSON: { url }
  if (contentType.includes("application/json")) {
    let body: { url?: unknown };
    try {
      body = (await req.json()) as typeof body;
    } catch {
      return NextResponse.json(
        { error: "Body is not valid JSON." },
        { status: 400 },
      );
    }
    if (typeof body.url !== "string" || !body.url.trim()) {
      return NextResponse.json(
        { error: "Missing 'url' field (string)." },
        { status: 400 },
      );
    }
    let fetched;
    try {
      fetched = await fetchUrlImage(body.url);
    } catch (err) {
      if (err instanceof UrlFetchError) {
        return NextResponse.json({ error: err.message }, { status: err.status });
      }
      return NextResponse.json(
        { error: `URL fetch failed: ${(err as Error).message}` },
        { status: 502 },
      );
    }
    return runExtract(fetched.buffer);
  }

  // multipart/form-data: { image | url }
  let form: FormData;
  try {
    form = await req.formData();
  } catch {
    return NextResponse.json(
      { error: "Body must be multipart/form-data or application/json." },
      { status: 400 },
    );
  }

  const file = form.get("image");
  const urlField = form.get("url");
  if (typeof urlField === "string" && urlField.trim()) {
    let fetched;
    try {
      fetched = await fetchUrlImage(urlField);
    } catch (err) {
      if (err instanceof UrlFetchError) {
        return NextResponse.json({ error: err.message }, { status: err.status });
      }
      return NextResponse.json(
        { error: `URL fetch failed: ${(err as Error).message}` },
        { status: 502 },
      );
    }
    return runExtract(fetched.buffer);
  }

  if (!(file instanceof File)) {
    return NextResponse.json(
      { error: "Missing field 'image' (single file) or 'url' (string)." },
      { status: 400 },
    );
  }
  const isPdf = file.type === PDF_MIME;
  const sizeCap = isPdf ? MAX_PDF_BYTES : MAX_BYTES;
  if (file.size > sizeCap) {
    return NextResponse.json(
      {
        error: isPdf
          ? `PDF exceeds ${sizeCap} bytes.`
          : `Image exceeds ${sizeCap} bytes. Please compress first.`,
      },
      { status: 413 },
    );
  }
  if (!ACCEPTED_MIME.has(file.type)) {
    return NextResponse.json(
      {
        error: `Unsupported MIME type "${file.type}". Use JPEG, PNG, WebP, or PDF.`,
      },
      { status: 415 },
    );
  }

  const raw = Buffer.from(await file.arrayBuffer());
  let buffer: Buffer;
  if (isPdf) {
    try {
      const extracted = await extractPdfFirstPage(raw);
      buffer = extracted.pngBuffer;
    } catch (err) {
      if (err instanceof PdfExtractError) {
        return NextResponse.json(
          { error: err.message, code: err.code },
          { status: err.code === "too-large" ? 413 : 400 },
        );
      }
      throw err;
    }
  } else {
    buffer = raw;
  }
  return runExtract(buffer);
}

async function runExtract(buffer: Buffer) {
  try {
    const result = await extractOnly(buffer, {});
    return NextResponse.json(result);
  } catch (err) {
    return NextResponse.json(
      { error: `Extraction failed: ${(err as Error).message}` },
      { status: 502 },
    );
  }
}
