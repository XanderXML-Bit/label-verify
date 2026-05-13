import { parse as parseCsv } from "csv-parse/sync";
import type { DeclaredFields } from "@/lib/types";
import { rowToDeclared } from "./row-to-declared";
import {
  detectJsonManifestShape,
  detectCsvManifestShape,
} from "./detect-manifest";

// ─── Structured-format parsers (JSON, CSV) ─────────────────────────────────
//
// JSON: accepts a single record, an array, OR a filename-keyed object
// map (the natural shape a reviewer writes when assembling a manifest
// by hand). When the caller knows which image is being verified
// (single-image-plus-multi-row-manifest flow), it can pass
// `imageFilename` so the right row is picked.
//
// CSV: same — single row, or multi-row with a `filename` / `image` /
// `label` column. `imageFilename` resolves to the matching row.
//
// When the file contains multiple rows AND no `imageFilename` is
// supplied, the first row is used and a warning is surfaced (the
// reviewer probably meant to use the batch flow).

interface ParseOptions {
  /**
   * Filename of the image being verified, if known. Used to pick the
   * matching row out of a multi-row manifest. Match is case-insensitive
   * and tolerates path-prefix differences.
   */
  imageFilename?: string;
}

function basename(filename: string): string {
  const slash = filename.lastIndexOf("/");
  const back = filename.lastIndexOf("\\");
  const cut = Math.max(slash, back);
  return cut >= 0 ? filename.slice(cut + 1) : filename;
}

function stemOf(filename: string): string {
  const base = basename(filename);
  const dot = base.lastIndexOf(".");
  return (dot > 0 ? base.slice(0, dot) : base).toLowerCase();
}

/** Pick the row matching `imageFilename` out of a list. Returns the
 *  index of the match, or -1 if none. Matches first on the exact
 *  basename, then on the filename stem (handles `.jpg` vs `.png` or
 *  paths with directories). */
function pickRowByFilename(
  rows: Record<string, string>[],
  imageFilename: string,
  filenameColumn: string,
): number {
  const targetBase = basename(imageFilename).toLowerCase();
  const targetStem = stemOf(imageFilename);
  let exactMatch = -1;
  let stemMatch = -1;
  for (let i = 0; i < rows.length; i++) {
    const v = rows[i]?.[filenameColumn];
    if (!v) continue;
    const rowBase = basename(v).toLowerCase();
    if (rowBase === targetBase) {
      exactMatch = i;
      break;
    }
    if (stemOf(v) === targetStem) stemMatch = i;
  }
  return exactMatch >= 0 ? exactMatch : stemMatch;
}

export function parseApplicationJson(
  text: string,
  options: ParseOptions = {},
): {
  fields: Partial<DeclaredFields>;
  warnings: string[];
} {
  const warnings: string[] = [];
  const shape = detectJsonManifestShape(text);
  if (shape.kind === "unparseable") {
    throw new Error(shape.reason);
  }

  if (shape.kind === "multi-row") {
    // Try to pick the row matching the caller-supplied image filename.
    // detectJsonManifestShape sets `hasFilenameColumn: true` and
    // `filenameColumn` for both filename-keyed object maps (synthesized
    // `filename` field) and array-of-rows with a real filename column.
    if (options.imageFilename && shape.hasFilenameColumn && shape.filenameColumn) {
      const idx = pickRowByFilename(
        shape.rows,
        options.imageFilename,
        shape.filenameColumn,
      );
      if (idx >= 0) {
        return { fields: rowToDeclared(shape.rows[idx]!), warnings };
      }
      warnings.push(
        `Manifest has ${shape.rows.length} rows but none matched image "${basename(options.imageFilename)}"; using the first row instead. Verify the manifest's filename column matches the uploaded image's filename.`,
      );
    } else {
      warnings.push(
        `JSON contains ${shape.rows.length} rows; using the first. Use the batch endpoint for multi-row inputs, or upload the image alongside this manifest so the matching row is picked automatically.`,
      );
    }
    return { fields: rowToDeclared(shape.rows[0]!), warnings };
  }

  // single-row: detectJsonManifestShape already produced a usable row.
  return { fields: rowToDeclared(shape.rows[0]!), warnings };
}

export function parseApplicationCsv(
  text: string,
  options: ParseOptions = {},
): {
  fields: Partial<DeclaredFields>;
  warnings: string[];
} {
  const warnings: string[] = [];
  const shape = detectCsvManifestShape(text);
  if (shape.kind === "unparseable") {
    throw new Error(shape.reason);
  }

  if (shape.kind === "multi-row") {
    if (options.imageFilename && shape.hasFilenameColumn && shape.filenameColumn) {
      const idx = pickRowByFilename(
        shape.rows,
        options.imageFilename,
        shape.filenameColumn,
      );
      if (idx >= 0) {
        return { fields: rowToDeclared(shape.rows[idx]!), warnings };
      }
      warnings.push(
        `CSV manifest has ${shape.rows.length} rows but none matched image "${basename(options.imageFilename)}"; using the first row instead.`,
      );
    } else {
      warnings.push(
        `CSV contains ${shape.rows.length} rows; using the first. Use the batch endpoint for multi-row inputs, or upload the image alongside this manifest so the matching row is picked automatically.`,
      );
    }
    return { fields: rowToDeclared(shape.rows[0]!), warnings };
  }

  return { fields: rowToDeclared(shape.rows[0]!), warnings };
}

// Re-export ParseOptions so callers (parseApplication) can build it
// from form input without re-declaring the shape.
export type { ParseOptions as StructuredParseOptions };

// Fallback shim for legacy callers that import only the parsers. Will
// be removed once every consumer is on the options-aware overload.
