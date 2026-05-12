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
import { parseApplication } from "@/lib/application/parse";
import {
  pairByFilenameStem,
  summarize,
  type PairingSummary,
} from "@/lib/batch-pairing";

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

  // Two supported paths for a batch:
  //
  //   1. EXPLICIT MANIFEST. A `manifest` form field (CSV or JSON) names
  //      each image by `filename` and inlines its declared fields. Use
  //      when the COLA system can export a structured manifest.
  //
  //   2. AUTO-PAIR (no manifest). The upload contains image files
  //      (JPEG/PNG/WebP/HEIC/HEIF) AND application files (PDF / JSON /
  //      CSV / MD / TXT). The route pairs them by filename stem
  //      (case-insensitive, ext-insensitive), parses each application
  //      file via `parseApplication`, and builds the batch. Use when
  //      the reviewer has a folder of paired files keyed by COLA
  //      number or brand slug.
  //
  // The response always includes a `pairing` summary so the operator
  // can see exactly what was matched and what was left over before
  // any vision call fires.
  const manifestEntry = form.get("manifest");
  const hasManifest = typeof manifestEntry === "string" && manifestEntry.trim().length > 0;

  const items: Omit<BatchItem, "status">[] = [];
  const pairingErrors: string[] = [];
  let pairing: PairingSummary;

  if (hasManifest) {
    // ─── Path 1: explicit manifest ────────────────────────────────────────
    let manifestRows: Record<string, string>[];
    try {
      const j = JSON.parse(manifestEntry as string);
      manifestRows = Array.isArray(j) ? j : [j];
    } catch {
      try {
        manifestRows = parseCsv(manifestEntry as string, {
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

    const pairs: Array<{ image: string; application: string; stem: string }> = [];
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
      pairs.push({ image: file.name, application: "manifest", stem: stem(filename) });
    }
    pairing = {
      mode: "manifest",
      totalItems: items.length,
      pairedCount: items.length,
      pairs,
      unpairedImages: [],
      unpairedApplications: [],
      ignored: [],
    };
  } else {
    // ─── Path 2: auto-pair by filename stem ──────────────────────────────
    const allFiles: File[] = [];
    for (const [, value] of form.entries()) {
      if (value instanceof File) allFiles.push(value);
    }
    if (allFiles.length === 0) {
      return NextResponse.json(
        { error: "No files provided. Upload images and application files together, or include a 'manifest' field." },
        { status: 400 },
      );
    }
    const pairResult = pairByFilenameStem(allFiles);
    pairing = summarize(pairResult, "auto-stem");

    if (pairResult.paired.length === 0) {
      return NextResponse.json(
        {
          error:
            "No image-application pairs found. Either include a 'manifest' field, OR upload paired files where each label image (.jpg/.png/.webp) has a matching application file (.pdf/.json/.csv/.md/.txt) with the same filename stem.",
          pairing,
        },
        { status: 400 },
      );
    }
    if (pairResult.paired.length > MAX_BATCH_ITEMS) {
      return NextResponse.json(
        {
          error: `Batch exceeds maximum capacity (${MAX_BATCH_ITEMS} items).`,
          pairing,
        },
        { status: 413 },
      );
    }

    for (const { imageFile, applicationFile, stem: s } of pairResult.paired) {
      if (imageFile.size > MAX_IMAGE_BYTES) {
        pairingErrors.push(`${imageFile.name}: image exceeds 10MB.`);
        continue;
      }
      if (!ACCEPTED_MIME.has(imageFile.type)) {
        pairingErrors.push(`${imageFile.name}: unsupported image MIME ${imageFile.type}.`);
        continue;
      }
      // Parse the application file.
      let parsed;
      try {
        const appBuf = Buffer.from(await applicationFile.arrayBuffer());
        parsed = await parseApplication({
          buffer: appBuf,
          filename: applicationFile.name,
          mime: applicationFile.type,
        });
      } catch (err) {
        pairingErrors.push(
          `${imageFile.name} ↔ ${applicationFile.name}: application parse failed — ${(err as Error).message}`,
        );
        continue;
      }
      // The parser returns Partial<DeclaredFields>. Batch verify
      // requires the full set — anything missing fails closed.
      const validated = DeclaredFieldsSchema.safeParse(parsed.fields);
      if (!validated.success) {
        const issues = validated.error.issues
          .slice(0, 3)
          .map((iss) => iss.path.join(".") + ": " + iss.message)
          .join("; ");
        pairingErrors.push(
          `${imageFile.name} ↔ ${applicationFile.name}: parsed application is missing required fields — ${issues}`,
        );
        continue;
      }
      const buf = Buffer.from(await imageFile.arrayBuffer());
      items.push({
        index: items.length,
        filename: imageFile.name,
        imageBytes: buf,
        mime: imageFile.type,
        declared: validated.data,
      });
      // Stem already recorded in `pairing`; nothing else to add here.
      void s;
    }
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
    pairing,
  });
}

function stem(filename: string): string {
  const base = filename.split(/[\\/]/).pop() ?? filename;
  const dot = base.lastIndexOf(".");
  return (dot > 0 ? base.slice(0, dot) : base).toLowerCase();
}
