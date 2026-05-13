#!/usr/bin/env tsx
// scripts/perturb-declared.ts
//
// Emit a parallel "wrong" declared-fields file for every ground-truth
// JSON in the canonical corpus. The bench then runs each label image
// twice — once against the correct GT, once against the perturbed GT —
// catching false-NEGATIVES (correct → fail) and false-POSITIVES
// (wrong → pass) symmetrically.
//
// Mutations applied per file (all five, every time):
//   1. brand_name           → unrelated brand cycled from a fixed list
//   2. class_type           → non-alias sibling within the same category
//   3. abv_percent          → +2.0 pp (beyond every class's tolerance)
//   4. net_contents.value   → ×2 (e.g. 12 fl_oz → 24 fl_oz)
//   5. country_of_origin    → swap to a different non-USA country
//
// Output: test-data-combined/declared-wrong/<basename>.json
// Deterministic (id-hashed picks) + idempotent (same input ⇒ same bytes).

import { readdir, readFile, writeFile, mkdir } from "node:fs/promises";
import { join } from "node:path";

const WRONG_BRANDS = [
  "Crowfoot Reserve", "Iron Harbor", "Saltwood Mill",
  "Northstar Trading", "Bramble & Vine", "Copperline",
] as const;

// Non-alias siblings within each class_category. Picking a sibling
// (not a synonym) guarantees the matcher's alias-aware comparator
// returns FAIL rather than PASS.
const CLASS_SIBLINGS: Record<string, readonly string[]> = {
  beer: ["Pilsner", "Stout", "IPA", "Porter", "Hefeweizen"],
  wine: ["Cabernet Sauvignon", "Chardonnay", "Pinot Noir", "Riesling"],
  distilled_spirits: ["Vodka", "Whisky", "Rum", "Gin", "Tequila"],
  fortified_wine: ["Port", "Sherry", "Madeira", "Vermouth"],
};

const WRONG_COUNTRIES = [
  "Mexico", "Germany", "Japan", "Italy", "France", "Scotland", "Ireland",
] as const;

/** Deterministic FNV-1a 32-bit hash; stable across Node versions. */
function hash32(s: string): number {
  let h = 0x811c9dc5;
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i);
    h = Math.imul(h, 0x01000193);
  }
  return h >>> 0;
}

function pickDistinct<T>(pool: readonly T[], current: T, key: string): T {
  const idx0 = hash32(key) % pool.length;
  for (let i = 0; i < pool.length; i++) {
    const cand = pool[(idx0 + i) % pool.length]!;
    if (cand !== current) return cand;
  }
  return pool[idx0]!;
}

interface GtFields {
  brand_name: string;
  class_type: string;
  class_category: string;
  abv_percent: number;
  net_contents: { value: number; unit: string };
  producer: unknown;
  country_of_origin: string | null;
  government_warning?: unknown;
}

interface GtFile {
  id: string;
  fields: GtFields;
  [k: string]: unknown;
}

export interface PerturbResult {
  perturbed: GtFile;
  mutatedFields: string[];
}

/** Pure transform: take a GT object, return a perturbed clone. */
export function perturb(gt: GtFile): PerturbResult {
  const out: GtFile = JSON.parse(JSON.stringify(gt)) as GtFile;
  const id = gt.id;
  const mutated: string[] = [];

  const newBrand = pickDistinct(WRONG_BRANDS, gt.fields.brand_name, `${id}:brand`);
  if (newBrand !== gt.fields.brand_name) {
    out.fields.brand_name = newBrand;
    mutated.push("brand_name");
  }

  const siblings = CLASS_SIBLINGS[String(gt.fields.class_category)];
  if (siblings && siblings.length > 0) {
    const newClass = pickDistinct(siblings, gt.fields.class_type, `${id}:class`);
    if (newClass !== gt.fields.class_type) {
      out.fields.class_type = newClass;
      mutated.push("class_type");
    }
  }

  // +2.0 pp clamped to [0, 100]. Beer ±0.3, wine ±1.5, spirits exact —
  // +2.0 violates every class's tolerance.
  if (typeof gt.fields.abv_percent === "number") {
    const newAbv = Math.min(100, Math.max(0, gt.fields.abv_percent + 2));
    if (newAbv !== gt.fields.abv_percent) {
      out.fields.abv_percent = newAbv;
      mutated.push("abv_percent");
    }
  }

  if (gt.fields.net_contents && typeof gt.fields.net_contents.value === "number") {
    out.fields.net_contents = { ...gt.fields.net_contents, value: gt.fields.net_contents.value * 2 };
    mutated.push("net_contents");
  }

  // GT often has country_of_origin === null (Codex couldn't visually
  // confirm). Treat null as "USA" for the comparison so we still set a
  // wrong non-USA country in that case.
  const currentCountry = gt.fields.country_of_origin ?? "USA";
  const newCountry = pickDistinct(WRONG_COUNTRIES, currentCountry, `${id}:country`);
  if (newCountry !== currentCountry) {
    out.fields.country_of_origin = newCountry;
    mutated.push("country_of_origin");
  }

  return { perturbed: out, mutatedFields: mutated };
}

async function main(): Promise<void> {
  const root = process.cwd();
  const corpusArg = process.argv.includes("--corpus")
    ? process.argv[process.argv.indexOf("--corpus") + 1]!
    : "test-data-combined";
  const truthsDir = join(root, corpusArg, "ground-truth");
  const outDir = join(root, corpusArg, "declared-wrong");
  await mkdir(outDir, { recursive: true });

  const entries = (await readdir(truthsDir)).filter((e) => e.endsWith(".json") && !e.startsWith("."));
  let written = 0;
  let skipped = 0;
  for (const name of entries) {
    const gt = JSON.parse(await readFile(join(truthsDir, name), "utf8")) as GtFile;
    if (!gt.fields) {
      skipped++;
      continue;
    }
    const { perturbed, mutatedFields } = perturb(gt);
    await writeFile(join(outDir, name), JSON.stringify(perturbed, null, 2) + "\n", "utf8");
    written++;
    if (process.env.VERBOSE) {
      // eslint-disable-next-line no-console
      console.log(`  ${name}: mutated ${mutatedFields.join(", ")}`);
    }
  }
  // eslint-disable-next-line no-console
  console.log(`perturb-declared: wrote ${written} files to ${outDir} (skipped ${skipped}).`);
}

const invokedDirectly =
  typeof process !== "undefined" &&
  process.argv[1] !== undefined &&
  /perturb-declared\.ts$/.test(process.argv[1]);
if (invokedDirectly) {
  main().catch((err: unknown) => {
    // eslint-disable-next-line no-console
    console.error(`perturb-declared: ${(err as Error).message}`);
    process.exit(1);
  });
}
