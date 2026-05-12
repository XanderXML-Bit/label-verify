import type { DeclaredFields } from "@/lib/types";

// ─── Shared row → DeclaredFields shim ──────────────────────────────────────
//
// Originally lived inline in src/app/api/verify/batch/route.ts as
// `rowToDeclared`. Application input (JSON / CSV / parsed-text formats)
// reuses exactly the same field aliases, so it lives here now and the
// batch route imports from this module. Keep the alias list permissive —
// reviewers may export from different TTB tools with slightly different
// column names, and the cost of accepting more aliases is one extra entry
// in a `get(...)` call.

export function rowToDeclared(
  row: Record<string, string>,
): Partial<DeclaredFields> {
  const get = (...keys: string[]): string | undefined => {
    for (const k of keys) {
      const v = row[k];
      if (v != null && String(v).trim() !== "") return String(v).trim();
    }
    return undefined;
  };

  const ncRaw =
    get("net_contents", "netContents", "net contents", "volume", "size") ?? "";
  // Accept "12 fl_oz", "12 fl oz", "355 ml", "750ml", "1.5 L", "75cl".
  const ncMatch = ncRaw.match(
    /^\s*(\d+(?:[.,]\d+)?)\s*(fl\s*oz|fl_oz|ml|cl|l)\s*$/i,
  );
  const netContents = ncMatch
    ? {
        value: Number(ncMatch[1]!.replace(",", ".")),
        unit:
          ncMatch[2]!.toLowerCase().replace(/\s/g, "_") === "fl_oz"
            ? ("fl_oz" as const)
            : (ncMatch[2]!.toLowerCase() as "ml" | "L" | "cl"),
      }
    : undefined;

  const classCategoryRaw = get("class_category", "category", "beverage_type");
  const classCategory = normalizeCategory(classCategoryRaw);

  // Allow producer as a free-form string OR a structured row of
  // address fields. The DeclaredFields union already accepts either.
  let producer: DeclaredFields["producer"] | undefined;
  const producerName = get("producer_name", "producer name");
  const producerLine = get("producer", "producer_address", "producer_line");
  if (producerName) {
    producer = {
      name: producerName,
      street: get("producer_street", "street") ?? null,
      city: get("producer_city", "city") ?? null,
      state: get("producer_state", "state") ?? null,
      postal_code: get("producer_postal", "postal_code", "zip") ?? null,
      country: get("producer_country") ?? null,
    };
  } else if (producerLine) {
    producer = producerLine;
  }

  return {
    brand_name: get("brand_name", "brand", "brand name"),
    class_type: get("class_type", "class", "type", "class/type", "style"),
    class_category: classCategory,
    abv_percent: numOrUndef(
      get("abv_percent", "abv", "abv%", "alcohol", "alcohol_by_volume"),
    ),
    net_contents: netContents,
    producer,
    country_of_origin: get("country", "country_of_origin", "origin"),
  };
}

function normalizeCategory(
  raw: string | undefined,
): DeclaredFields["class_category"] | undefined {
  if (!raw) return undefined;
  const lower = raw.toLowerCase().trim();
  if (lower === "beer" || lower === "malt") return "beer";
  if (lower === "wine") return "wine";
  if (lower === "distilled_spirits" || lower === "spirits" || lower === "distilled spirits")
    return "distilled_spirits";
  if (lower === "fortified_wine" || lower === "fortified wine") return "fortified_wine";
  return undefined;
}

function numOrUndef(s: string | undefined): number | undefined {
  if (s == null) return undefined;
  const n = Number(String(s).replace(/%/g, "").replace(",", ".").trim());
  return Number.isFinite(n) ? n : undefined;
}
