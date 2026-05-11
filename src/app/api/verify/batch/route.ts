import { NextResponse } from "next/server";
import { parse as parseCsv } from "csv-parse/sync";
import { DeclaredFieldsSchema } from "@/lib/types";
import { createBatch, type BatchItem } from "@/lib/batch-store";

export const runtime = "nodejs";
export const maxDuration = 60;

const MAX_BATCH = Number(process.env.MAX_BATCH_SIZE ?? 300);
const MAX_IMAGE_BYTES = 10 * 1024 * 1024;

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
 * which kicks off per-item verifications (one Vercel function invocation
 * per item) and streams results back.
 */
export async function POST(req: Request) {
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
    // Build the DeclaredFields object from the row.
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

  const job = createBatch(items);
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

/**
 * Map a manifest row to the DeclaredFields shape. CSV columns can use
 * either snake_case or human names; we accept common variants.
 */
function rowToDeclared(row: Record<string, string>): unknown {
  const get = (...keys: string[]): string | undefined => {
    for (const k of keys) {
      const v = row[k];
      if (v != null && v !== "") return v;
    }
    return undefined;
  };
  const ncRaw = get("net_contents", "netContents", "net contents") ?? "";
  // Accept "12 fl_oz", "12 fl oz", "355 ml", "750ml", etc.
  const ncMatch = ncRaw.match(/^\s*(\d+(?:\.\d+)?)\s*(fl\s*oz|fl_oz|ml|cl|l)\s*$/i);
  return {
    brand_name: get("brand_name", "brand", "brand name"),
    class_type: get("class_type", "class", "type", "class/type"),
    class_category: (get("class_category", "category") ?? "beer").toLowerCase(),
    abv_percent: numOrUndef(get("abv_percent", "abv", "abv%", "alcohol")),
    net_contents: ncMatch
      ? {
          value: Number(ncMatch[1]),
          unit: ncMatch[2]!.toLowerCase().replace(/\s/g, "_") === "fl_oz"
            ? "fl_oz"
            : (ncMatch[2]!.toLowerCase() as "ml" | "L" | "cl"),
        }
      : undefined,
    producer: get("producer", "producer_name_address", "producer name"),
    country_of_origin: get("country", "country_of_origin", "origin"),
  };
}

function numOrUndef(s: string | undefined): number | undefined {
  if (s == null) return undefined;
  const n = Number(String(s).replace(/%/g, "").trim());
  return Number.isFinite(n) ? n : undefined;
}
