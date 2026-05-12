import { NextResponse } from "next/server";
import { verifyLabel } from "@/lib/verify";
import { DeclaredFieldsSchema } from "@/lib/types";
import { UrlFetchError, fetchUrlImage } from "@/lib/input-handlers";
import { callerKey, rateLimit } from "@/lib/rate-limit";

export const runtime = "nodejs";
// Vercel max for hobby plan is 10s; we run within a 5s vision budget.
export const maxDuration = 60;

const ACCEPTED_MIME = new Set([
  "image/jpeg",
  "image/png",
  "image/webp",
  "image/heic",
  "image/heif",
]);
const MAX_BYTES = 10 * 1024 * 1024; // 10 MB
const RATE_LIMIT_PER_MIN = Number(process.env.RATE_LIMIT_PER_MIN ?? 60);

export async function POST(req: Request) {
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
    return runVerify(fetched.buffer, parsed.data, rl);
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
    return runVerify(fetched.buffer, parsed.data, rl);
  }

  if (!(file instanceof File)) {
    return NextResponse.json(
      { error: "Missing field 'image' (single file) or 'url' (string)." },
      { status: 400 },
    );
  }
  if (file.size > MAX_BYTES) {
    return NextResponse.json(
      { error: `Image exceeds ${MAX_BYTES} bytes. Please compress first.` },
      { status: 413 },
    );
  }
  if (!ACCEPTED_MIME.has(file.type)) {
    return NextResponse.json(
      { error: `Unsupported MIME type "${file.type}". Use JPEG, PNG, or WebP.` },
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

  const buffer = Buffer.from(await file.arrayBuffer());
  return runVerify(buffer, parsed.data, rl);
}

async function runVerify(
  buffer: Buffer,
  declared: import("@/lib/types").DeclaredFields,
  rl: import("@/lib/rate-limit").RateLimitResult,
) {
  try {
    const result = await verifyLabel(buffer, declared);
    return NextResponse.json(result, {
      headers: {
        "X-RateLimit-Remaining": String(rl.remaining),
      },
    });
  } catch (err) {
    const e = err as Error;
    const aborted = e.name === "AbortError";
    return NextResponse.json(
      {
        error: aborted
          ? "Vision call exceeded the 5 s budget."
          : `Verification failed: ${e.message}`,
        aborted,
      },
      { status: aborted ? 504 : 500 },
    );
  }
}
