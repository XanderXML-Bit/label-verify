// Classifier that distinguishes a "multi-row manifest" application file
// (a CSV with N rows or a JSON array with N objects) from a normal
// "single-product" application file. Used by the batch route to figure
// out whether a dropped application file is actually a roster of N
// products that should pair to N images, or a single application that
// should pair to one (or be broadcast across many).
//
// Pure structural detection. No vision, no I/O. The route + the
// structured parsers both consume this so the rule lives in one place.

import { parse as parseCsv } from "csv-parse/sync";

// Column-header normaliser — accepts the most common reviewer-export
// conventions for "which image does this row describe".
const FILENAME_COLUMN_ALIASES = new Set([
  "filename",
  "file",
  "image",
  "image_filename",
  "image_name",
  "label",
  "label_filename",
  "label_image",
  "cola_number",
  "cola",
  "cola_id",
  "id",
]);

function normaliseColumnName(name: string): string {
  return name
    .toLowerCase()
    .trim()
    .replace(/[\s_-]+/g, "_");
}

export type ManifestShape =
  | {
      kind: "single-row";
      /** Always exactly one row. */
      rows: [Record<string, string>];
      hasFilenameColumn: false;
    }
  | {
      kind: "multi-row";
      rows: Record<string, string>[];
      /** True iff any column header normalises to a known
       *  filename-pointing alias. When false, the route falls back to
       *  positional pairing or surfaces the rows as orphans. */
      hasFilenameColumn: boolean;
      /** The actual column name that matched the alias, if any. The
       *  pairer reads `row[filenameColumn]` to look up the image. */
      filenameColumn: string | null;
    }
  | {
      kind: "unparseable";
      reason: string;
    };

/**
 * Detect whether a CSV string describes a multi-row manifest or a
 * single-product application. The CSV is parsed once with `columns:
 * true` (header row → object keys). Empty CSVs are `unparseable`.
 */
export function detectCsvManifestShape(text: string): ManifestShape {
  let rows: Record<string, string>[];
  try {
    rows = parseCsv(text, {
      columns: true,
      skip_empty_lines: true,
      trim: true,
    });
  } catch (err) {
    return { kind: "unparseable", reason: `CSV parse error: ${(err as Error).message}` };
  }
  if (rows.length === 0) {
    return { kind: "unparseable", reason: "CSV is empty." };
  }
  if (rows.length === 1) {
    return {
      kind: "single-row",
      rows: [rows[0]!],
      hasFilenameColumn: false,
    };
  }
  // Multi-row. Find a filename-pointing column.
  const columns = Object.keys(rows[0]!);
  let filenameColumn: string | null = null;
  for (const col of columns) {
    if (FILENAME_COLUMN_ALIASES.has(normaliseColumnName(col))) {
      filenameColumn = col;
      break;
    }
  }
  return {
    kind: "multi-row",
    rows,
    hasFilenameColumn: filenameColumn !== null,
    filenameColumn,
  };
}

/**
 * Detect whether a JSON string describes a multi-row manifest (array of
 * length > 1) or a single-product application (object, or single-element
 * array). Empty arrays / non-object roots are `unparseable`.
 */
export function detectJsonManifestShape(text: string): ManifestShape {
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch (err) {
    return { kind: "unparseable", reason: `JSON parse error: ${(err as Error).message}` };
  }
  if (Array.isArray(parsed)) {
    if (parsed.length === 0) {
      return { kind: "unparseable", reason: "JSON array is empty." };
    }
    // Coerce each element into a Record<string, string> the pairer
    // can consume. Nested objects are flattened one level the same
    // way parseApplicationJson handles them.
    const rows: Record<string, string>[] = parsed.map((el) => coerceToRow(el));
    if (rows.length === 1) {
      return { kind: "single-row", rows: [rows[0]!], hasFilenameColumn: false };
    }
    // Find filename column.
    const columns = Object.keys(rows[0]!);
    let filenameColumn: string | null = null;
    for (const col of columns) {
      if (FILENAME_COLUMN_ALIASES.has(normaliseColumnName(col))) {
        filenameColumn = col;
        break;
      }
    }
    return {
      kind: "multi-row",
      rows,
      hasFilenameColumn: filenameColumn !== null,
      filenameColumn,
    };
  }
  if (typeof parsed === "object" && parsed !== null) {
    return {
      kind: "single-row",
      rows: [coerceToRow(parsed)],
      hasFilenameColumn: false,
    };
  }
  return { kind: "unparseable", reason: "JSON root must be an object or an array." };
}

/** Flatten one level of nested object → string-valued top-level row.
 *  Matches the convention `parseApplicationJson` already uses so the
 *  downstream `rowToDeclared` accepts both shapes uniformly. */
function coerceToRow(record: unknown): Record<string, string> {
  if (typeof record !== "object" || record === null) return {};
  const row: Record<string, string> = {};
  for (const [k, v] of Object.entries(record as Record<string, unknown>)) {
    if (v == null) continue;
    if (typeof v === "object" && !Array.isArray(v)) {
      for (const [sk, sv] of Object.entries(v as Record<string, unknown>)) {
        if (sv == null) continue;
        row[`${k}_${sk}`] = String(sv);
      }
      if (k === "net_contents" && "value" in (v as object) && "unit" in (v as object)) {
        const obj = v as { value: unknown; unit: unknown };
        row.net_contents = `${obj.value} ${obj.unit}`;
      }
    } else {
      row[k] = String(v);
    }
  }
  return row;
}
