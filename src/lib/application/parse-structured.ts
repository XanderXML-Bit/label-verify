import { parse as parseCsv } from "csv-parse/sync";
import type { DeclaredFields } from "@/lib/types";
import { rowToDeclared } from "./row-to-declared";

// ─── Structured-format parsers (JSON, CSV) ─────────────────────────────────
//
// JSON: accept an object (single record) or an array of length 1 (first
// row wins — multi-row JSON is a batch manifest, not a single-label
// application). Already-canonical field names take priority over alias
// lookups so a perfectly-formed export round-trips unchanged.
//
// CSV: same logic as the batch manifest. We re-use csv-parse/sync since
// it's already in the dep tree (see api/verify/batch/route.ts). One-row
// CSVs feed the same rowToDeclared shim everything else uses.

export function parseApplicationJson(text: string): {
  fields: Partial<DeclaredFields>;
  warnings: string[];
} {
  const warnings: string[] = [];
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch (err) {
    throw new Error(`JSON parse error: ${(err as Error).message}`);
  }
  // Accept either a single record or the first row of an array.
  let record: unknown = parsed;
  if (Array.isArray(parsed)) {
    if (parsed.length === 0) {
      throw new Error("JSON array is empty.");
    }
    if (parsed.length > 1) {
      warnings.push(
        `JSON contains ${parsed.length} rows; using the first. Use the batch endpoint for multi-row inputs.`,
      );
    }
    record = parsed[0];
  }
  if (typeof record !== "object" || record === null) {
    throw new Error("JSON root must be an object (single record) or an array.");
  }
  // Coerce all top-level values to strings so rowToDeclared can parse
  // them. Numbers (e.g. abv: 6.4) come out as "6.4", and the alias
  // resolver handles the rest.
  const row: Record<string, string> = {};
  for (const [k, v] of Object.entries(record as Record<string, unknown>)) {
    if (v == null) continue;
    if (typeof v === "object") {
      // Nested object (e.g. net_contents: { value: 12, unit: "fl_oz" })
      // is reassembled by rowToDeclared if the fields it cares about are
      // present at the top level, so we flatten one level here.
      for (const [sk, sv] of Object.entries(v as Record<string, unknown>)) {
        if (sv == null) continue;
        row[`${k}_${sk}`] = String(sv);
      }
      // Also include a re-stringified value for the parent key so
      // rowToDeclared's net_contents matcher can re-pattern e.g.
      // "12 fl_oz" — most JSON exports use the flat string form, this
      // is just a defensive shim.
      if (k === "net_contents" && "value" in (v as object) && "unit" in (v as object)) {
        const obj = v as { value: unknown; unit: unknown };
        row.net_contents = `${obj.value} ${obj.unit}`;
      }
    } else {
      row[k] = String(v);
    }
  }
  return { fields: rowToDeclared(row), warnings };
}

export function parseApplicationCsv(text: string): {
  fields: Partial<DeclaredFields>;
  warnings: string[];
} {
  const warnings: string[] = [];
  let rows: Record<string, string>[];
  try {
    rows = parseCsv(text, {
      columns: true,
      skip_empty_lines: true,
      trim: true,
    });
  } catch (err) {
    throw new Error(`CSV parse error: ${(err as Error).message}`);
  }
  if (rows.length === 0) {
    throw new Error("CSV is empty.");
  }
  if (rows.length > 1) {
    warnings.push(
      `CSV contains ${rows.length} rows; using the first. Use the batch endpoint for multi-row inputs.`,
    );
  }
  return { fields: rowToDeclared(rows[0]!), warnings };
}
