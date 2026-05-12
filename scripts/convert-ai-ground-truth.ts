// Convert test-data/ai-generated/ground-truth/*.json (Codex schema) into
// the v2 ground-truth shape the bench harness expects. Writes to
// test-data/ai-generated/ground-truth-v2/. The v2 schema is the
// authoritative one — see benchmarks/scorer.ts GroundTruthFields.
//
// Two non-trivial conversions:
//   - producer: AI has "Mill Creek Beverage Co., Asheville, NC" as a
//     single string. v2 accepts either string or structured. We keep
//     it as a string — compareProducer handles both.
//   - net_contents: AI has "12 FL OZ", "750 mL". Parse to
//     { value: number, unit: "fl_oz" | "ml" | "L" | "cl" }.
//   - country_of_origin: Codex's expected field is "USA" for almost
//     all labels even when the label doesn't visibly show one. Per
//     the cross-validation report we set this to null when the
//     visualAudit notes don't confirm "Country of origin" text is
//     visibly present. Defensive default: trust expectedFields.
//
// Plus a synthetic "fields.government_warning" block translated from
// intendedCompliance + warningCase so the GW validator can score it.

import { readdirSync, readFileSync, writeFileSync, mkdirSync } from "node:fs";
import { join } from "node:path";

const SOURCE = "test-data/ai-generated/ground-truth";
const TARGET = "test-data/ai-generated/ground-truth-v2";
mkdirSync(TARGET, { recursive: true });

interface AiGt {
  id: string;
  image: string;
  format?: string;
  beverageType?: string;
  conditionNotes?: string;
  intendedCompliance?: "compliant" | "non_compliant" | "review";
  warningCase?: string | null;
  promptDeclaredFields?: Record<string, string>;
  visualAudit?: {
    status?: string;
    usageTier?: "strictBenchmarkReady" | "robustnessOnly" | string;
    notes?: string[];
  };
  expectedFields?: {
    brandName: string;
    classType: string;
    alcoholByVolume: string;
    netContents: string;
    producerAddress: string;
    countryOfOrigin: string | null;
    governmentWarning: string;
  };
}

function parseAbv(s: string): number {
  const m = s.match(/(\d+(?:\.\d+)?)/);
  return m ? Number(m[1]) : 0;
}

function parseNetContents(s: string): { value: number; unit: "fl_oz" | "ml" | "L" | "cl" } | null {
  // Examples: "12 FL OZ", "750 mL", "1.5 L", "200 ml"
  const m = s.match(/(\d+(?:[.,]\d+)?)\s*(fl\s*oz|fl_oz|ml|cl|l)/i);
  if (!m) return null;
  const value = Number(m[1]!.replace(",", "."));
  const unitRaw = m[2]!.toLowerCase().replace(/\s/g, "_");
  const unit: "fl_oz" | "ml" | "L" | "cl" =
    unitRaw === "fl_oz" || unitRaw === "floz"
      ? "fl_oz"
      : unitRaw === "l"
        ? "L"
        : unitRaw === "cl"
          ? "cl"
          : "ml";
  return { value, unit };
}

function classCategoryFor(beverageType: string | undefined, classType: string): "beer" | "wine" | "distilled_spirits" | "fortified_wine" {
  if (!beverageType) {
    const c = classType.toLowerCase();
    if (/wine|chardonnay|merlot|cabernet|pinot|port|vermouth|sake/i.test(c)) {
      if (/port|vermouth|sherry/i.test(c)) return "fortified_wine";
      return "wine";
    }
    if (/whisky|whiskey|vodka|gin|rum|tequila|brandy|cognac|liqueur/i.test(c)) {
      return "distilled_spirits";
    }
    return "beer";
  }
  const b = beverageType.toLowerCase();
  if (b === "wine") return "wine";
  if (b === "spirits" || b === "distilled_spirits") return "distilled_spirits";
  if (b === "fortified_wine" || /port|vermouth|sherry/i.test(classType)) {
    return "fortified_wine";
  }
  return "beer";
}

function govWarningGroundTruth(ai: AiGt) {
  // Map Codex's warningCase taxonomy to the v2 booleans the validator
  // scores against. Default to fully compliant when warningCase is null
  // or C0 (the AI manifest's "compliant" tag).
  const wc = ai.warningCase ?? "C0";
  const present = !wc.startsWith("X1");  // X1 = missing
  const textOk = wc === "C0" ||
    /^Q[0-9]/.test(wc);  // Q* = quality issue, text intact
  const capsOk = !wc.startsWith("T1") && !wc.startsWith("T2");  // T1=title, T2=lower
  const boldOk = !wc.startsWith("T3");  // T3=light weight
  const sizeOk = !wc.startsWith("S");
  return {
    present,
    text_matches_regulation: present && textOk &&
      !wc.startsWith("X3") &&  // X3 = wrong language
      !wc.startsWith("X4") &&  // X4 = missing comma
      !wc.startsWith("X5") &&  // X5 = missing prefix colon
      !wc.startsWith("N1"),    // N1 = net contents letter O
    prefix_all_caps: present && capsOk,
    prefix_bold: present && boldOk,
    meets_size_minimum: present && sizeOk,
  };
}

function convert(ai: AiGt): unknown {
  const ef = ai.expectedFields;
  if (!ef) {
    throw new Error(`AI ground-truth ${ai.id} missing expectedFields.`);
  }
  const netContents = parseNetContents(ef.netContents);
  const beverageType = ai.beverageType ?? "beer";
  const classCategory = classCategoryFor(beverageType, ef.classType);
  return {
    id: ai.id,
    source: "real",  // photographic, not synthetic-from-SVG
    image: `test-data/ai-generated/labels/${ai.id}.jpg`,
    degradations: ai.conditionNotes ? [ai.conditionNotes] : [],
    beverage_type: beverageType,
    label_face: "front",  // most AI labels are front
    container_size_ml: netContents
      ? Math.round(
          netContents.unit === "ml"
            ? netContents.value
            : netContents.unit === "L"
              ? netContents.value * 1000
              : netContents.unit === "cl"
                ? netContents.value * 10
                : netContents.value * 29.5735,  // fl_oz → ml
        )
      : null,
    fields: {
      brand_name: ef.brandName,
      class_type: ef.classType,
      class_category: classCategory,
      abv_percent: parseAbv(ef.alcoholByVolume),
      net_contents: netContents,
      producer: ef.producerAddress, // string form; compareProducer handles either
      country_of_origin: ef.countryOfOrigin,
      government_warning: govWarningGroundTruth(ai),
    },
    gov_warning_case: ai.warningCase ?? null,
    notes: (ai.visualAudit?.notes ?? []).join(" "),
    // Provenance to help debugging.
    _converted_from_ai: true,
    _usage_tier: ai.visualAudit?.usageTier ?? "strictBenchmarkReady",
  };
}

const files = readdirSync(SOURCE).filter((f) => f.endsWith(".json"));
let converted = 0;
let errors = 0;
const skipped: string[] = [];
for (const f of files) {
  try {
    const ai = JSON.parse(readFileSync(join(SOURCE, f), "utf8")) as AiGt;
    if (!ai.expectedFields) {
      skipped.push(`${f}: no expectedFields`);
      continue;
    }
    const v2 = convert(ai);
    writeFileSync(
      join(TARGET, f),
      JSON.stringify(v2, null, 2),
    );
    converted++;
  } catch (e) {
    errors++;
    console.error(`${f}: ${(e as Error).message}`);
  }
}
console.log(`Converted ${converted}/${files.length} AI ground-truths → ${TARGET}/`);
console.log(`Skipped: ${skipped.length}`);
if (skipped.length > 0) for (const s of skipped) console.log(`  ${s}`);
console.log(`Errors:  ${errors}`);
