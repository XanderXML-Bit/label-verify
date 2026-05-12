import { NextResponse } from "next/server";
import { parse as parseCsv } from "csv-parse/sync";
import { DeclaredFieldsSchema } from "@/lib/types";
import {
  BatchStoreFullError,
  createBatch,
  type BatchItem,
} from "@/lib/batch-store";
import {
  configuredMaxBatchItems,
  MAX_BATCH_BODY_BYTES,
} from "@/lib/batch-capacity";
import { callerKey, rateLimit } from "@/lib/rate-limit";
import { rowToDeclared } from "@/lib/application/row-to-declared";

export const runtime = "nodejs";
export const maxDuration = 60;

// Interactive batch cap. Computed from provider RPM × stream window
// (see lib/batch-capacity.ts) — yields ~100 labels by default for
// Gemini Flash-Lite Tier 1, scales up if GEMINI_RPM_LIMIT is bumped.
// Hard ceiling MAX_BATCH_SIZE (env, default 1000) overrides upward.
export const MAX_BATCH_ITEMS = configuredMaxBatchItems();
const MAX_IMAGE_BYTES = 10 * 1024 * 1024;
// Lower per-IP create-rate so a single client can't queue dozens of
// 100-item batches in a minute and starve the stream worker.
const RATE_LIMIT_BATCH_PER_MIN = Number(process.env.RATE_LIMIT_BATCH_PER_MIN ?? 3);

const ACCEPTED_MIME = new Set([
  "image/jpeg",
  "image/png",
  "image/webp",
  "image/heic",
  "image/heif",
]);

/**
 * POST /api/verify/batch
 *
 * Accepts a multipart/form-data body:
 *   - "manifest"  CSV or JSON of declared fields per row, with at minimum
 *                 a "filename" column to pair with images.
 *   - "image"     repeated; each file's `name` must match a manifest row.
 *
 * Returns { batchId }. The client then opens an SSE connection to
 *   GET /api/verify/batch/<id>/stream
 * which kicks off per-item verifications and streams results back.
 *
 * Capacity:
 *   - Item count capped at MAX_BATCH_ITEMS (computed from
 *     GEMINI_RPM_LIMIT × stream window, ceilinged by MAX_BATCH_SIZE).
 *   - Body bytes capped at MAX_BATCH_BYTES (256 MiB by default; small
 *     enough to stay materially under the 1 GB function memory after
 *     formData buffering, big enough for ~100 real label photos).
 *   - Per-IP rate limit dedicated to batch creation (`batch-create:`
 *     bucket), at RATE_LIMIT_BATCH_PER_MIN (default 3/min) — distinct
 *     from /api/verify so a noisy batch client cannot starve single-
 *     image traffic.
 */
export const MAX_BATCH_BYTES = MAX_BATCH_BODY_BYTES;

export async function POST(req: Request) {
  const key = callerKey(req.headers);
  const rl = rateLimit(`batch-create:${key}`, {
    perMinute: RATE_LIMIT_BATCH_PER_MIN,
    burst: RATE_LIMIT_BATCH_PER_MIN,
  });
  if (!rl.allowed) {
    return NextResponse.json(
      { error: `Batch creation rate limit exceeded. Try again in ${rl.resetSeconds}s.` },
      {
        status: 429,
        headers: {
          "Retry-After": String(rl.resetSeconds),
          "X-RateLimit-Remaining": "0",
        },
      },
    );
  }

  const lenHeader = req.headers.get("content-length");
  if (!lenHeader) {
    return NextResponse.json(
      { error: "Batch uploads require a Content-Length header." },
      { status: 411 },
    );
  }
  const declaredLength = Number(lenHeader);
  if (!Number.isFinite(declaredLength) || declaredLength < 0) {
    return NextResponse.json(
      { error: "Invalid Content-Length header." },
      { status: 400 },
    );
  }
  if (declaredLength > MAX_BATCH_BYTES) {
    return NextResponse.json(
      {
        error: `Batch body exceeds ${MAX_BATCH_BYTES} bytes. Split the upload into multiple smaller batches.`,
      },
      { status: 413 },
    );
  }

  let form: FormData;
  try {
    form = await req.formData();
  } catch {
    return NextResponse.json(
      { error: "Body must be multipart/form-data." },
      { status: 400 },
    );
  }

  const manifestEntry = form.get("manifest");
  if (typeof manifestEntry !== "string") {
    return NextResponse.json(
      { error: "Missing 'manifest' field (CSV or JSON)." },
      { status: 400 },
    );
  }

  // Manifest: try JSON first, then CSV.
  let manifestRows: Record<string, string>[];
  try {
    const j = JSON.parse(manifestEntry);
    manifestRows = Array.isArray(j) ? j : [j];
  } catch {
    try {
      manifestRows = parseCsv(manifestEntry, {
        columns: true,
        skip_empty_lines: true,
        trim: true,
      });
    } catch (e) {
      return NextResponse.json(
        {
          error: `Manifest could not be parsed as JSON or CSV: ${(e as Error).message}`,
        },
        { status: 400 },
      );
    }
  }

  if (manifestRows.length === 0) {
    return NextResponse.json(
      { error: "Manifest is empty." },
      { status: 400 },
    );
  }
  if (manifestRows.length > MAX_BATCH_ITEMS) {
    return NextResponse.json(
      { error: `Batch exceeds maximum capacity (${MAX_BATCH_ITEMS} items).` },
      { status: 413 },
    );
  }

  // Collect images. The form may include several files all named "image"
  // OR distinct field names per filename — accept either.
  const fileMap = new Map<string, File>();
  for (const [key, value] of form.entries()) {
    if (key === "manifest") continue;
    if (value instanceof File) {
      fileMap.set(stem(value.name), value);
    }
  }
  if (fileMap.size === 0) {
    return NextResponse.json(
      { error: "No images provided." },
      { status: 400 },
    );
  }

  const items: Omit<BatchItem, "status">[] = [];
  const pairingErrors: string[] = [];
  for (let i = 0; i < manifestRows.length; i++) {
    const row = manifestRows[i]!;
    const filename = (row.filename ?? row.file ?? row.image ?? "").trim();
    if (!filename) {
      pairingErrors.push(`Row ${i}: missing 'filename' column.`);
      continue;
    }
    const file = fileMap.get(stem(filename));
    if (!file) {
      pairingErrors.push(`Row ${i}: no uploaded image matches "${filename}".`);
      continue;
    }
    if (file.size > MAX_IMAGE_BYTES) {
      pairingErrors.push(`Row ${i} (${filename}): image exceeds 10MB.`);
      continue;
    }
    if (!ACCEPTED_MIME.has(file.type)) {
      pairingErrors.push(
        `Row ${i} (${filename}): unsupported MIME ${file.type}.`,
      );
      continue;
    }
    // Build the DeclaredFields object from the row using the shared shim.
    const declaredCandidate = rowToDeclared(row);
    const parsed = DeclaredFieldsSchema.safeParse(declaredCandidate);
    if (!parsed.success) {
      pairingErrors.push(
        `Row ${i} (${filename}): declared fields invalid — ${parsed.error.issues[0]?.message}`,
      );
      continue;
    }
    const buf = Buffer.from(await file.arrayBuffer());
    items.push({
      index: items.length,
      filename,
      imageBytes: buf,
      mime: file.type,
      declared: parsed.data,
    });
  }

  if (items.length === 0) {
    return NextResponse.json(
      {
        error:
          "No valid (image, declared-fields) pairs after manifest parse.",
        pairingErrors,
      },
      { status: 400 },
    );
  }

  let job;
  try {
    job = createBatch(items);
  } catch (err) {
    if (err instanceof BatchStoreFullError) {
      return NextResponse.json({ error: err.message }, { status: 503 });
    }
    throw err;
  }
  return NextResponse.json({
    batchId: job.id,
    count: items.length,
    pairingErrors,
  });
}

function stem(filename: string): string {
  const base = filename.split(/[\\/]/).pop() ?? filename;
  const dot = base.lastIndexOf(".");
  return (dot > 0 ? base.slice(0, dot) : base).toLowerCase();
}
