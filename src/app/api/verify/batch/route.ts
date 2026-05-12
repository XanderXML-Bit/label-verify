import { NextResponse } from "next/server";
import { parse as parseCsv } from "csv-parse/sync";
import { DeclaredFieldsSchema } from "@/lib/types";
import {
  BatchStoreFullError,
  createBatch,
  type BatchItem,
} from "@/lib/batch-store";
import { callerKey, rateLimit } from "@/lib/rate-limit";
import { rowToDeclared } from "@/lib/application/row-to-declared";

export const runtime = "nodejs";
export const maxDuration = 60;

// Default cap raised to 1000 per project lead's explicit ask
// (2026-05-12). Operators can override via the MAX_BATCH_SIZE env var.
// The brief's stated 200–300 range is the conservative floor; 1000 is
// reachable in practice because per-item Vercel function invocations
// avoid the 30 s per-batch SSE wall-clock cap.
const MAX_BATCH = Number(process.env.MAX_BATCH_SIZE ?? 1000);
const MAX_IMAGE_BYTES = 10 * 1024 * 1024;
const RATE_LIMIT_PER_MIN = Number(process.env.RATE_LIMIT_PER_MIN ?? 60);

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
 */
// Per-batch body cap. MAX_BATCH=1000 × 10 MB/image = 10 GB theoretical
// worst-case, but real-world labels average ~1 MB, so legitimate
// 1000-image batches typically run ~1-2 GB. The 5 GB cap absorbs the
// 99th-percentile legitimate workload while keeping a DoS guard
// against pathologically large bodies before `formData()` buffers
// them into the 2 GB Vercel function memory. Anything bigger gets a
// 413 from the Content-Length pre-check below — no buffering, no
// OOM. Clients hitting this cap should split their upload.
const MAX_BATCH_BYTES = 5 * 1024 * 1024 * 1024; // 5 GB

export async function POST(req: Request) {
  // ─── Rate limit ──────────────────────────────────────────────────────────
  const key = callerKey(req.headers);
  const rl = rateLimit(`batch:${key}`, { perMinute: RATE_LIMIT_PER_MIN });
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

  const lenHeader = req.headers.get("content-length");
  if (lenHeader) {
    const declared = Number(lenHeader);
    if (Number.isFinite(declared) && declared > MAX_BATCH_BYTES) {
      return NextResponse.json(
        {
          error: `Batch body exceeds ${MAX_BATCH_BYTES} bytes. Split the upload into multiple smaller batches.`,
        },
        { status: 413 },
      );
    }
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
  if (manifestRows.length > MAX_BATCH) {
    return NextResponse.json(
      { error: `Batch exceeds MAX_BATCH_SIZE (${MAX_BATCH}).` },
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
