import { NextResponse } from "next/server";
import { verifyLabel } from "@/lib/verify";
import { DeclaredFieldsSchema } from "@/lib/types";
import type { DeclaredFields } from "@/lib/types";
import { UrlFetchError, fetchUrlImage } from "@/lib/input-handlers";
import { callerKey, rateLimit } from "@/lib/rate-limit";
import type { RateLimitResult } from "@/lib/rate-limit";
import { recordTrace } from "@/lib/debug-trace";
import { enqueueForReview, makeReviewItemId } from "@/lib/review-queue";
import {
  MAX_PDF_BYTES,
  PdfExtractError,
  extractPdfFirstPage,
} from "@/lib/pdf";

export const runtime = "nodejs";
// 60 s ceiling matches Vercel Hobby. The vision call has its own
// per-mode budget in `verify.ts:timeoutForMode()` (15–60 s) — this
// is the outer wall.
export const maxDuration = 60;

const PDF_MIME = "application/pdf";
const ACCEPTED_MIME = new Set([
  "image/jpeg",
  "image/png",
  "image/webp",
  "image/heic",
  "image/heif",
  PDF_MIME,
]);
const MAX_BYTES = 10 * 1024 * 1024; // 10 MB (image upload ceiling)
const RATE_LIMIT_PER_MIN = Number(process.env.RATE_LIMIT_PER_MIN ?? 60);

export async function POST(req: Request) {
  // Middleware sets X-Request-Id on every inbound /api/* request — pick
  // it up here so log lines and error responses are correlatable.
  const requestId = req.headers.get("x-request-id") ?? undefined;

  // ─── Rate limit ──────────────────────────────────────────────────────────
  const key = callerKey(req.headers);
  const rl = rateLimit(`verify:${key}`, { perMinute: RATE_LIMIT_PER_MIN });
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

  // ─── JSON body: { url, declared } ────────────────────────────────────────
  // Any `mode` field is silently ignored (see runVerify comment).
  if (contentType.includes("application/json")) {
    let body: { url?: unknown; declared?: unknown };
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
    const parsed = DeclaredFieldsSchema.safeParse(body.declared);
    if (!parsed.success) {
      return NextResponse.json(
        {
          error: "Declared fields failed schema validation.",
          issues: parsed.error.issues,
        },
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
    return runVerify(fetched.buffer, parsed.data, rl, undefined, requestId);
  }

  // ─── multipart/form-data: { image, declared } ────────────────────────────
  let formData: FormData;
  try {
    formData = await req.formData();
  } catch {
    return NextResponse.json(
      { error: "Body must be multipart/form-data or application/json." },
      { status: 400 },
    );
  }

  const file = formData.get("image");
  const declaredRaw = formData.get("declared");
  const urlField = formData.get("url");
  // Any `mode` field is silently ignored (see runVerify comment).

  // URL inside a multipart body is supported as a convenience for the UI.
  if (typeof urlField === "string" && urlField.trim()) {
    if (typeof declaredRaw !== "string") {
      return NextResponse.json(
        { error: "Missing field 'declared' (JSON-encoded DeclaredFields)." },
        { status: 400 },
      );
    }
    let declaredJson: unknown;
    try {
      declaredJson = JSON.parse(declaredRaw);
    } catch {
      return NextResponse.json(
        { error: "Field 'declared' is not valid JSON." },
        { status: 400 },
      );
    }
    const parsed = DeclaredFieldsSchema.safeParse(declaredJson);
    if (!parsed.success) {
      return NextResponse.json(
        {
          error: "Declared fields failed schema validation.",
          issues: parsed.error.issues,
        },
        { status: 400 },
      );
    }
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
    return runVerify(fetched.buffer, parsed.data, rl, undefined, requestId);
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
  if (typeof declaredRaw !== "string") {
    return NextResponse.json(
      { error: "Missing field 'declared' (JSON-encoded DeclaredFields)." },
      { status: 400 },
    );
  }

  let declaredJson: unknown;
  try {
    declaredJson = JSON.parse(declaredRaw);
  } catch {
    return NextResponse.json(
      { error: "Field 'declared' is not valid JSON." },
      { status: 400 },
    );
  }
  const parsed = DeclaredFieldsSchema.safeParse(declaredJson);
  if (!parsed.success) {
    return NextResponse.json(
      {
        error: "Declared fields failed schema validation.",
        issues: parsed.error.issues,
      },
      { status: 400 },
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
          { error: pdfErrorMessage(err) },
          { status: pdfErrorStatus(err.code) },
        );
      }
      return NextResponse.json(
        { error: `PDF processing failed: ${(err as Error).message}` },
        { status: 500 },
      );
    }
  } else {
    buffer = raw;
  }
  return runVerify(buffer, parsed.data, rl, file.name, requestId);
}

function pdfErrorStatus(code: PdfExtractError["code"]): number {
  switch (code) {
    case "encrypted":
      return 415;
    case "empty":
      return 400;
    case "too-large":
      return 413;
    case "render-failed":
      return 500;
  }
}

function pdfErrorMessage(err: PdfExtractError): string {
  if (err.code === "encrypted") return "PDF is password-protected.";
  if (err.code === "empty") return "PDF has no pages.";
  return err.message;
}

async function runVerify(
  buffer: Buffer,
  declared: DeclaredFields,
  rl: RateLimitResult,
  filename?: string,
  requestId?: string,
) {
  // The route used to thread a `mode` parameter through to the
  // orchestrator. The model picker was retired (single production
  // path) and exposing it on the public API would let an
  // unauthenticated caller route to a costlier/different tier — a
  // real abuse surface flagged in the Hermes pre-submission audit
  // (BLOCKER #3). Any `mode` field in the request body or form is
  // now silently ignored. Operators running internal A/B tests can
  // still inject an Extractor via the internal `extractor` option.
  try {
    const result = await verifyLabel(buffer, declared, {
      recordTrace,
    });
    if (result.requiresHumanReview) {
      try {
        enqueueForReview({
          id: makeReviewItemId(),
          source: "single",
          ...(filename ? { filename } : {}),
          enqueuedAt: Date.now(),
          declared,
          verifyResponse: result,
          reasons: result.reviewReasons,
        });
      } catch {
        // Swallow — the queue is an in-memory affordance, not a hard
        // dependency. We must not turn a successful verify into a 500.
      }
    }
    return NextResponse.json(result, {
      headers: {
        "X-RateLimit-Remaining": String(rl.remaining),
        ...(requestId ? { "X-Request-Id": requestId } : {}),
      },
    });
  } catch (err) {
    const e = err as Error;
    const aborted = e.name === "AbortError";
    // Include the request id in the error body too — users reporting a
    // failure can copy it out of the toast / error panel without having
    // to inspect response headers (R2).
    if (requestId) {
      console.warn(`[verify] requestId=${requestId} failed: ${e.message}`);
    }
    return NextResponse.json(
      {
        error: aborted
          ? "Vision call exceeded its per-mode time budget. Try again, or pick a different mode if a Smart-tier call is timing out."
          : `Verification failed: ${e.message}`,
        aborted,
        ...(requestId ? { requestId } : {}),
      },
      {
        status: aborted ? 504 : 500,
        ...(requestId ? { headers: { "X-Request-Id": requestId } } : {}),
      },
    );
  }
}
