import { NextResponse } from "next/server";
import { parse as parseCsv } from "csv-parse/sync";
import { DeclaredFieldsSchema } from "@/lib/types";
import {
  BatchStoreFullError,
  createBatch,
  deleteBatch,
  type BatchItem,
} from "@/lib/batch-store";
import {
  configuredMaxBatchItems,
  MAX_BATCH_BODY_BYTES,
} from "@/lib/batch-capacity";
import { callerKey, rateLimit } from "@/lib/rate-limit";
import { rowToDeclared } from "@/lib/application/row-to-declared";
import { parseApplication } from "@/lib/application/parse";
import type { DeclaredFields, VerifyResponse } from "@/lib/types";
import {
  detectCsvManifestShape,
  detectJsonManifestShape,
} from "@/lib/application/detect-manifest";
import {
  classifyFile,
  stem as pairingStem,
} from "@/lib/batch-pairing";
import {
  pairByContent,
  pairByFilenameStem,
  summarize,
  type ApplicationFingerprint,
  type ImageFingerprint,
  type PairingSummary,
} from "@/lib/batch-pairing";
import { preprocessImage } from "@/lib/preprocess";
import { GeminiFlashExtractor } from "@/lib/vision/gemini";

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

// Per-request cache for already-parsed application files. Previously
// stashed via File mutation (`(file as any).__cachedParsed = ...`),
// which leaked `@ts-expect-error` suppressions throughout this route
// AND was a runtime hazard (File is structured-cloneable; mutations
// don't survive any clone). WeakMap is the proper shape: typed,
// garbage-collected with the File reference, and unambiguous about
// the cache being request-local. Per Agent D code-quality audit
// 2026-05-13.
type ParsedApplication = Awaited<ReturnType<typeof parseApplication>>;

export async function POST(req: Request) {
  const parsedAppCache = new WeakMap<File, ParsedApplication>();
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
  // Non-fatal pairing notes — surfaces things like "scanned PDF was
  // parsed via vision OCR fallback at low confidence; verify the
  // declared values for this row." Distinguished from pairingErrors
  // (which gate the pair out) so the reviewer sees the verify proceed
  // but with the caveat attached. Codex audit finding.
  const pairingWarnings: string[] = [];
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
    // ─── Inline-manifest detection (NEW 2026-05-12) ────────────────────────
    //
    // Before any filename-stem or content pairing, check if any of the
    // dropped application files is actually a MULTI-ROW MANIFEST (CSV
    // with N rows of {filename, fields...} or JSON array of N objects).
    // If so, expand it into per-image pairings — this is the user's
    // reported case of "12 images + 1 CSV containing all 12 → currently
    // fails with no-pairs-found". The expanded pairs land in
    // `pairResult.paired` exactly like a stem match, with
    // `source: "manifest-inline"` so the UI labels them correctly.
    //
    // Detection rules (see detect-manifest.ts):
    //   • CSV: > 1 data row → multi-row.
    //   • JSON: array of length > 1 → multi-row.
    // Single-row CSV/JSON falls through to the normal flow (filename or
    // content pair). Multi-row WITHOUT a recognisable `filename`-aliased
    // column also falls through (we can't safely match rows to images
    // without that signal — let content pairing try its weight).
    const allFiles_classified = allFiles.map((f) => ({
      file: f,
      kind: classifyFile(f),
    }));
    const candidateImages = allFiles_classified.filter((x) => x.kind === "image").map((x) => x.file);
    const candidateApps = allFiles_classified.filter((x) => x.kind === "application").map((x) => x.file);
    const inlineManifestPairs: Array<{
      imageFile: File;
      applicationFile: File;
      stem: string;
      source: "manifest-inline";
      cachedDeclared: Record<string, string>;
    }> = [];
    const orphanedManifestRows: string[] = [];
    const consumedAppsInManifestPath = new Set<File>();
    let inlineManifestDidFire = false;
    for (const appFile of candidateApps) {
      // Only CSV / JSON files can be manifests. Skip PDFs, DOCX, etc.
      const isCsv =
        appFile.type === "text/csv" ||
        appFile.type === "application/csv" ||
        appFile.name.toLowerCase().endsWith(".csv");
      const isJson =
        appFile.type === "application/json" ||
        appFile.type === "text/json" ||
        appFile.name.toLowerCase().endsWith(".json");
      if (!isCsv && !isJson) continue;
      let text: string;
      try {
        const buf = Buffer.from(await appFile.arrayBuffer());
        text = buf.toString("utf-8");
      } catch {
        continue;
      }
      const shape = isCsv ? detectCsvManifestShape(text) : detectJsonManifestShape(text);
      if (shape.kind !== "multi-row" || !shape.hasFilenameColumn || !shape.filenameColumn) {
        // Either not multi-row, or multi-row without a filename column
        // — fall through to normal pairing.
        continue;
      }
      inlineManifestDidFire = true;
      // Pair each row to an image by filename stem.
      const imagesByStem = new Map(candidateImages.map((img) => [pairingStem(img.name), img]));
      const matchedImagesInThisManifest = new Set<File>();
      for (let i = 0; i < shape.rows.length; i++) {
        const row = shape.rows[i]!;
        const rawFilename = (row[shape.filenameColumn] ?? "").trim();
        if (!rawFilename) {
          orphanedManifestRows.push(
            `${appFile.name} row ${i + 1}: empty filename column.`,
          );
          continue;
        }
        const img = imagesByStem.get(pairingStem(rawFilename));
        if (!img) {
          orphanedManifestRows.push(
            `${appFile.name} row ${i + 1} (filename "${rawFilename}"): no matching image in this upload.`,
          );
          continue;
        }
        if (matchedImagesInThisManifest.has(img)) {
          // Manifest references the same image twice — surface and
          // keep the first match.
          orphanedManifestRows.push(
            `${appFile.name} row ${i + 1} (filename "${rawFilename}"): image already paired earlier in this manifest.`,
          );
          continue;
        }
        matchedImagesInThisManifest.add(img);
        inlineManifestPairs.push({
          imageFile: img,
          applicationFile: appFile,
          stem: pairingStem(img.name),
          source: "manifest-inline",
          cachedDeclared: row,
        });
      }
      if (matchedImagesInThisManifest.size > 0) {
        consumedAppsInManifestPath.add(appFile);
      }
    }

    // Remove inline-manifest-paired images from the input set so the
    // existing pairByFilenameStem / pairByContent paths only see the
    // residual. Build a fresh allFiles list excluding manifest-consumed
    // apps + manifest-paired images.
    const consumedImagesInManifestPath = new Set(
      inlineManifestPairs.map((p) => p.imageFile),
    );
    const filesForStemPath = allFiles.filter(
      (f) =>
        !consumedAppsInManifestPath.has(f) &&
        !consumedImagesInManifestPath.has(f),
    );
    const pairResult = pairByFilenameStem(filesForStemPath);
    // Splice manifest pairs back into the result.
    for (const p of inlineManifestPairs) {
      pairResult.paired.push({
        imageFile: p.imageFile,
        applicationFile: p.applicationFile,
        stem: p.stem,
        source: p.source,
      });
    }
    let pairingMode: PairingSummary["mode"] = inlineManifestDidFire
      ? "auto-inline-manifest"
      : "auto-stem";

    // Content-based fallback pairing. When filename stems don't fully
    // pair the upload (e.g. the reviewer dropped randomly-named files,
    // or the apps and images came from different export pipelines with
    // different conventions), extract a fingerprint from each unpaired
    // image and fuzzy-match against the parsed brand/class of each
    // unpaired application. Cost: one Gemini Flash Lite call per
    // unpaired image; only fires when stem pairing leaves anything
    // unpaired. User-explicit ask (2026-05-12): the system should
    // figure out which image goes with which app even on completely
    // randomly named files.
    if (
      pairResult.unpairedImages.length > 0 &&
      pairResult.unpairedApplications.length > 0 &&
      process.env.GOOGLE_API_KEY
    ) {
      try {
        const apiKey = process.env.GOOGLE_API_KEY;
        // Parse each unpaired app's fingerprint (brand_name +
        // class_type + abv_percent are enough to disambiguate). The
        // full parse is needed downstream anyway for the verify
        // path, but we don't double-buffer here: we parse them up
        // front, hold the parsed payloads in a map, and reuse them
        // in the loop below so each app file is read once.
        const parsedAppFingerprints: Array<{
          file: File;
          fingerprint: ApplicationFingerprint;
          // Stash the parsed payload so the per-pair loop below can
          // reuse it without re-parsing.
          parsed: Awaited<ReturnType<typeof parseApplication>>;
        }> = [];
        for (const app of pairResult.unpairedApplications) {
          try {
            const buf = Buffer.from(await app.arrayBuffer());
            const parsed = await parseApplication({
              buffer: buf,
              filename: app.name,
              mime: app.type,
              apiKey,
            });
            parsedAppFingerprints.push({
              file: app,
              fingerprint: {
                brand_name: parsed.fields.brand_name ?? null,
                class_type: parsed.fields.class_type ?? null,
                abv_percent: parsed.fields.abv_percent ?? null,
              },
              parsed,
            });
          } catch {
            // Best-effort: a broken app file just means no content
            // fingerprint; filename pairing already failed, so it
            // remains unpaired. Surface in pairingErrors below.
          }
        }
        // Extract a fingerprint from each unpaired image using a
        // bare Gemini Flash Lite call. Run in parallel — there are
        // typically a handful of unpaired items.
        const extractor = new GeminiFlashExtractor({ apiKey });
        const imageFingerprints: Array<{
          file: File;
          fingerprint: ImageFingerprint;
        }> = await Promise.all(
          pairResult.unpairedImages.map(async (img) => {
            try {
              const buf = Buffer.from(await img.arrayBuffer());
              const pre = await preprocessImage(buf);
              const result = await extractor.extract(pre.buffer);
              return {
                file: img,
                fingerprint: {
                  brand_name: result.fields.brand_name.value ?? null,
                  class_type: result.fields.class_type.value ?? null,
                  abv_percent: result.fields.abv_percent.value ?? null,
                },
              };
            } catch {
              return { file: img, fingerprint: {} };
            }
          }),
        );
        // Fuzzy-match.
        const contentPaired = pairByContent(
          imageFingerprints,
          parsedAppFingerprints.map((x) => ({
            file: x.file,
            fingerprint: x.fingerprint,
          })),
        );
        if (contentPaired.paired.length > 0) {
          pairingMode = "auto-stem+content";
          // Merge content pairs into the main pairing result so the
          // rest of the route can iterate over a single list.
          pairResult.paired.push(...contentPaired.paired);
          pairResult.unpairedImages = contentPaired.remainingImages;
          pairResult.unpairedApplications = contentPaired.remainingApplications;
          // For each content-paired item, stash the already-parsed
          // app payload in parsedAppCache so the per-pair loop below
          // doesn't re-parse the file. Keyed by the File reference;
          // the cache is request-local (declared at the top of POST).
          for (const hit of contentPaired.paired) {
            const stashed = parsedAppFingerprints.find(
              (p) => p.file === hit.applicationFile,
            );
            if (stashed) {
              parsedAppCache.set(hit.applicationFile, stashed.parsed);
            }
          }
          // Surface what was content-paired so the reviewer sees it.
          for (const hit of contentPaired.paired) {
            pairingWarnings.push(
              `${hit.imageFile.name} ↔ ${hit.applicationFile.name}: paired by CONTENT (filename stems didn't match; brand/class similarity score ${hit.score?.toFixed(2)}). Verify the pairing if the brand/class looks wrong.`,
            );
          }
        }
      } catch (err) {
        // Content pairing is best-effort. Any failure leaves the
        // filename-only pairing as the final result; the existing
        // unpaired list is what the reviewer sees.
        pairingErrors.push(
          `Content-pairing fallback failed: ${(err as Error).message}. Filenames are the only pairing signal.`,
        );
      }
    }

    // ─── Broadcast case (NEW 2026-05-12) ──────────────────────────────────
    //
    // If after inline-manifest + filename + content pairing, we still
    // have ≥ 2 unpaired images AND exactly 1 unpaired application file
    // AND that single app file is a single-product application (not a
    // multi-row manifest — those were already handled above), broadcast
    // the same parsed fields to every unpaired image. The reviewer
    // explicitly asked for this: "if one app file describes a single
    // product and N images are uploaded, the natural read is 'all N
    // labels are of that product; verify each against the same
    // declared fields.'" Surfaced as a warning so the operator can
    // reject it post-hoc.
    let broadcastFired = false;
    if (
      pairResult.unpairedImages.length >= 2 &&
      pairResult.unpairedApplications.length === 1
    ) {
      const broadcastApp = pairResult.unpairedApplications[0]!;
      try {
        const cached = parsedAppCache.get(broadcastApp);
        const parsed =
          cached ??
          (await parseApplication({
            buffer: Buffer.from(await broadcastApp.arrayBuffer()),
            filename: broadcastApp.name,
            mime: broadcastApp.type,
            ...(process.env.GOOGLE_API_KEY
              ? { apiKey: process.env.GOOGLE_API_KEY }
              : {}),
          }));
        // Stash for reuse by the per-pair loop.
        parsedAppCache.set(broadcastApp, parsed);
        const n = pairResult.unpairedImages.length;
        for (const img of pairResult.unpairedImages) {
          pairResult.paired.push({
            imageFile: img,
            applicationFile: broadcastApp,
            stem: pairingStem(img.name),
            source: "manifest-broadcast",
          });
        }
        pairResult.unpairedImages = [];
        pairResult.unpairedApplications = [];
        broadcastFired = true;
        pairingMode = "auto-broadcast";
        pairingWarnings.push(
          `Single-application broadcast: "${broadcastApp.name}" applied to ${n} images (no filename matches, no manifest detected). If these images are NOT all of the same product, drop a multi-row CSV manifest or per-image application files instead.`,
        );
      } catch {
        // If the broadcast app itself won't parse, fall through to
        // the "no pairs" error below.
      }
    }

    pairing = summarize(pairResult, pairingMode);
    if (broadcastFired) {
      pairing.broadcast = true;
    }
    if (orphanedManifestRows.length > 0) {
      pairing.orphanedManifestRows = orphanedManifestRows;
      // Also surface each orphan as a non-fatal warning so the route's
      // `pairingWarnings` aggregator (rendered in the UI) shows them
      // inline next to the actual pairs.
      for (const o of orphanedManifestRows) {
        pairingWarnings.push(o);
      }
    }

    if (pairResult.paired.length === 0) {
      return NextResponse.json(
        {
          error:
            "No image-application pairs found. The auto-pairer tried filename stems, then a multi-row manifest scan (CSV/JSON with a `filename` column), then brand/class content similarity — none yielded a match. Either include a `manifest` field, or upload each image alongside a matching application file.",
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

    // Build a quick lookup from (imageFile → cached manifest row) so the
    // per-pair loop can use the inline-manifest row directly instead of
    // calling parseApplication on the whole multi-row file (which would
    // collapse all 12 rows down to row-0 for every pair).
    const inlineManifestRowsByImage = new Map<File, Record<string, string>>();
    for (const p of inlineManifestPairs) {
      inlineManifestRowsByImage.set(p.imageFile, p.cachedDeclared);
    }
    for (const { imageFile, applicationFile, stem: s, source } of pairResult.paired) {
      if (imageFile.size > MAX_IMAGE_BYTES) {
        pairingErrors.push(`${imageFile.name}: image exceeds 10MB.`);
        continue;
      }
      if (!ACCEPTED_MIME.has(imageFile.type)) {
        pairingErrors.push(`${imageFile.name}: unsupported image MIME ${imageFile.type}.`);
        continue;
      }
      // Three sources for the parsed declared fields:
      //   1. Inline manifest: the application file is a multi-row CSV/
      //      JSON; this pair's row was cached during the detection pass.
      //      Run it through rowToDeclared just like the explicit-manifest
      //      path does.
      //   2. Content-paired: parseApplication was already called for
      //      the fingerprint; reuse the cached payload.
      //   3. Stem-paired: parse the file fresh (PDF-vision auto-fallback
      //      applies when GOOGLE_API_KEY is configured).
      let parsed: Awaited<ReturnType<typeof parseApplication>>;
      const inlineRow = inlineManifestRowsByImage.get(imageFile);
      if (inlineRow) {
        parsed = {
          fields: rowToDeclared(inlineRow),
          source: applicationFile.name.toLowerCase().endsWith(".json")
            ? "json"
            : "csv",
          warnings: [],
          confidence: "medium",
        };
      } else {
        const cachedParsed = parsedAppCache.get(applicationFile);
        if (cachedParsed) {
          parsed = cachedParsed;
        } else {
          try {
            const appBuf = Buffer.from(await applicationFile.arrayBuffer());
            parsed = await parseApplication({
              buffer: appBuf,
              filename: applicationFile.name,
              mime: applicationFile.type,
              ...(process.env.GOOGLE_API_KEY
                ? { apiKey: process.env.GOOGLE_API_KEY }
                : {}),
            });
          } catch (err) {
            pairingErrors.push(
              `${imageFile.name} ↔ ${applicationFile.name}: application parse failed — ${(err as Error).message}`,
            );
            continue;
          }
        }
      }
      void source; // documented above; not used for control flow here.
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
      // Codex audit fix: when the application was parsed via the
      // scanned-PDF vision fallback, `parsed.confidence === "low"` and
      // the warnings list explains why. Surface that as a non-fatal
      // note so the operator sees in the response payload that this
      // row's declared values came from OCR-on-a-scan and should be
      // sanity-checked. Previously the batch route just consumed
      // `parsed.fields` and dropped the confidence + warnings on the
      // floor.
      if (parsed.confidence === "low" || parsed.warnings.length > 0) {
        pairingWarnings.push(
          `${imageFile.name} ↔ ${applicationFile.name}: application parsed at ${parsed.confidence} confidence (source: ${parsed.source}) — ${parsed.warnings.join(" / ") || "verify the declared values manually."}`,
        );
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

  let job: ReturnType<typeof createBatch>;
  try {
    job = createBatch(items);
  } catch (err) {
    if (err instanceof BatchStoreFullError) {
      return NextResponse.json({ error: err.message }, { status: 503 });
    }
    throw err;
  }

  // ─── Inline batch processing (NEW 2026-05-13) ──────────────────────────
  //
  // The original design used a two-step flow: POST creates an in-memory
  // batch, GET /stream/[id] opens an SSE pipe to drain it. That works
  // beautifully on a single Node process but FAILS on Vercel serverless
  // — the POST and the SSE GET land on different function instances
  // (different cold/warm pools), and the in-memory Map isn't shared.
  // The SSE GET would 404 because `getBatch(id)` looks in the wrong
  // instance's store. The user hit this exact failure on production
  // 2026-05-13.
  //
  // Fix: process the whole batch inline in the POST handler and
  // return all results in one response. We lose the streaming-progress
  // UX, but the batch is bounded (≤ MAX_BATCH_ITEMS = ~100) and runs
  // with CONCURRENCY=2 (≤ ~50s for 100 items at ~3s each / 2 parallel)
  // — fits comfortably inside the 60s POST timeout configured in
  // vercel.json. The client renders the loading banner during the
  // wait; results pop in atomically when the response lands.
  //
  // The SSE endpoint stays in the codebase (`/stream/[id]`) for any
  // local-dev / single-process consumer that wants it, but the
  // production UI now consumes the inline results.
  const CONCURRENCY = 2;
  const startedAt = Date.now();
  let cursor = 0;
  async function pumpInline(): Promise<void> {
    while (true) {
      const idx = cursor++;
      if (idx >= job.items.length) return;
      const item = job.items[idx]!;
      item.status = "running";
      try {
        const result = await verifyLabelInline(item.imageBytes, item.declared);
        item.status = "done";
        item.result = result;
      } catch (err) {
        item.status = "error";
        item.error = (err as Error).message;
      }
    }
  }
  await Promise.all(Array.from({ length: CONCURRENCY }, () => pumpInline()));
  // Build the result rows in image-order.
  const results = job.items.map((item) => {
    if (item.status === "done" && item.result) {
      return {
        index: item.index,
        filename: item.filename,
        status: "done" as const,
        result: item.result,
      };
    }
    return {
      index: item.index,
      filename: item.filename,
      status: "error" as const,
      error: item.error ?? "Verification failed",
    };
  });
  const passed = results.filter((r) => r.status === "done" && r.result?.verdict === "pass").length;
  const failed = results.filter((r) => r.status === "done" && r.result?.verdict === "fail").length;
  const review = results.filter((r) => r.status === "done" && r.result?.verdict === "review").length;
  const errored = results.filter((r) => r.status === "error").length;
  // Release the in-memory job — it served its purpose for the inline
  // processing concurrency primitives; we don't keep it for SSE pickup.
  try { deleteBatch(job.id); } catch { /* already gone */ }

  return NextResponse.json({
    batchId: job.id,
    count: items.length,
    pairingErrors,
    pairingWarnings,
    pairing,
    inline: true,
    results,
    summary: { passed, failed, review, errored },
    elapsedMs: Date.now() - startedAt,
  });
}

// Lazy import to keep the module graph shallow on cold-start.
async function verifyLabelInline(
  imageBytes: Buffer,
  declared: DeclaredFields,
): Promise<VerifyResponse> {
  const { verifyLabel } = await import("@/lib/verify");
  return verifyLabel(imageBytes, declared);
}

function stem(filename: string): string {
  const base = filename.split(/[\\/]/).pop() ?? filename;
  const dot = base.lastIndexOf(".");
  return (dot > 0 ? base.slice(0, dot) : base).toLowerCase();
}
