import type { DeclaredFields } from "@/lib/types";
import { rowToDeclared } from "./row-to-declared";

// ─── Free-form text application-document parser ────────────────────────────
//
// Accepts TXT / MD or anything stringy that follows the common "Label /
// Value" pattern reviewers will paste from a TTB application export. We
// look for lines like:
//
//   Brand Name:       Stone's Throw IPA
//   Class / Type:     India Pale Ale
//   Class category:   beer
//   ABV:              6.4%
//   Net contents:     12 fl oz
//   Producer:         Stone Brewing Co., San Diego, CA
//   Country of origin: USA
//
// Order and capitalisation don't matter; whitespace after the colon and
// markdown asterisks/backticks are stripped. Missing fields are left
// undefined for the form to top up.

interface LabelValue {
  label: string;
  value: string;
}

const FIELD_ALIASES: Record<string, string> = {
  // Map normalised label text → canonical column name used by rowToDeclared.
  brand: "brand_name",
  "brand name": "brand_name",
  "brand_name": "brand_name",
  class: "class_type",
  "class type": "class_type",
  "class_type": "class_type",
  "class/type": "class_type",
  type: "class_type",
  style: "class_type",
  "fanciful name": "brand_name",
  category: "class_category",
  "class category": "class_category",
  "beverage type": "class_category",
  "beverage_type": "class_category",
  abv: "abv_percent",
  "abv_percent": "abv_percent",
  "alcohol": "abv_percent",
  "alcohol content": "abv_percent",
  "alcohol by volume": "abv_percent",
  "alcohol_by_volume": "abv_percent",
  "alc/vol": "abv_percent",
  "net contents": "net_contents",
  "net content": "net_contents",
  "net_contents": "net_contents",
  volume: "net_contents",
  size: "net_contents",
  producer: "producer",
  "producer name": "producer_name",
  "producer_name": "producer_name",
  "produced by": "producer",
  "bottled by": "producer",
  "manufacturer": "producer",
  country: "country_of_origin",
  "country of origin": "country_of_origin",
  "country_of_origin": "country_of_origin",
  origin: "country_of_origin",
};

const LINE_PATTERN = /^[\s>\-*•·]*([^:#=]+?)\s*[:=]\s*(.+?)\s*$/;

/**
 * Parse the body of a free-form application document and return the
 * fields we could recognise. Lines that don't match the "Label: value"
 * pattern are silently ignored — they may be intro paragraphs, table of
 * contents, signature blocks, etc.
 */
export function parseApplicationText(text: string): {
  fields: Partial<DeclaredFields>;
  warnings: string[];
  fieldsFound: string[];
} {
  const warnings: string[] = [];
  const row: Record<string, string> = {};

  // Strip markdown emphasis so "**Brand Name:** X" parses the same as
  // "Brand Name: X". Keep the table-pipe character so people can paste
  // markdown tables (a single-row table effectively gives us KV pairs).
  const cleaned = text
    .replace(/\*\*/g, "")
    .replace(/__/g, "")
    .replace(/`/g, "");

  for (const raw of cleaned.split(/\r?\n/)) {
    const trimmed = raw.trim();
    if (!trimmed) continue;
    const tableRow = parseMarkdownTableRow(trimmed);
    if (tableRow) {
      for (const lv of tableRow) addRow(row, lv);
      continue;
    }
    const matched = trimmed.match(LINE_PATTERN);
    if (!matched) continue;
    addRow(row, { label: matched[1]!.trim(), value: matched[2]!.trim() });
  }

  const fields = rowToDeclared(row);
  // `rowToDeclared` always emits `country_of_origin: null` so the
  // schema's .nullish() branch accepts US-domestic-omission rows.
  // For the "how many fields were actually recognised in the input"
  // count below, treat the auto-null country the same as undefined —
  // it doesn't represent a value the parser found in the source text.
  const fieldsFound = Object.keys(fields).filter((k) => {
    const v = (fields as Record<string, unknown>)[k];
    if (v === undefined) return false;
    if (k === "country_of_origin" && v === null && !row.country_of_origin && !row.country && !row.origin)
      return false;
    return true;
  });
  if (fieldsFound.length === 0) {
    warnings.push(
      "No application fields recognised. The file may not follow a 'Field: value' format — fill the form in manually.",
    );
  } else {
    const declaredKeys: (keyof DeclaredFields)[] = [
      "brand_name",
      "class_type",
      "class_category",
      "abv_percent",
      "net_contents",
      "producer",
      "country_of_origin",
    ];
    const missing = declaredKeys.filter((k) => !fieldsFound.includes(k));
    if (missing.length > 0) {
      warnings.push(
        `Parsed ${fieldsFound.length} of 7 fields. Missing: ${missing.join(", ")}. Fill those in manually.`,
      );
    }
  }
  return { fields, warnings, fieldsFound };
}

function addRow(
  row: Record<string, string>,
  { label, value }: LabelValue,
): void {
  // Normalise whitespace and slash-spacing so "Class / Type", "Class/Type",
  // and "class type" all hit the same alias entry. The pattern below
  // collapses any whitespace-around-slash to a bare slash, then squeezes
  // remaining whitespace to single spaces.
  const normalised = label
    .toLowerCase()
    .replace(/\s*\/\s*/g, "/")
    .replace(/\s+/g, " ")
    .trim();
  const key = FIELD_ALIASES[normalised];
  if (!key) return;
  if (!(key in row) || row[key] === "") row[key] = value;
}

function parseMarkdownTableRow(line: string): LabelValue[] | null {
  if (!line.startsWith("|")) return null;
  // Skip the separator row of a markdown table.
  if (/^\|[\s:|-]+\|?$/.test(line)) return null;
  const cells = line.split("|").map((c) => c.trim()).filter((c) => c !== "");
  if (cells.length !== 2) return null;
  return [{ label: cells[0]!, value: cells[1]! }];
}
