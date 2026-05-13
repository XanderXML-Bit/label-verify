#!/usr/bin/env tsx
// bin/diagnose.ts
//
// Per-image diagnostic harness for the cross-pair bench. Calls
// verifyLabel on a single (image, GT) pair and prints the full
// verdict response — verdict, per-field statuses + reasons,
// Government Warning subscores (text / caps / bold / size), image
// quality, second-opinion (if fired), and review reasons.
//
// Wave-13: built to drill into specific bench failures (e.g. the
// "crisp synthetic compliant" false-fails the oracle flagged) and
// identify which subscore is throwing the verdict, without paying
// the cost of a full 340-task cross-pair run.
//
// Usage:
//   tsx bin/diagnose.ts <image-path> <gt-json-path>
//   tsx bin/diagnose.ts --corpus <dir> <image-stem>
//
// Examples:
//   tsx bin/diagnose.ts test-data-combined/labels/ai-label-0035.jpg \
//                       test-data-combined/ground-truth/ai-label-0035.json
//
//   tsx bin/diagnose.ts --corpus test-data-combined ai-label-0035

import { existsSync, readFileSync } from "node:fs";
import { readFile } from "node:fs/promises";
import { resolve, join } from "node:path";
import { DeclaredFieldsSchema } from "../src/lib/types";

function loadDotenv(path: string): void {
  if (!existsSync(path)) return;
  for (const raw of readFileSync(path, "utf8").split(/\r?\n/)) {
    const line = raw.trim();
    if (!line || line.startsWith("#")) continue;
    const eq = line.indexOf("=");
    if (eq < 0) continue;
    const k = line.slice(0, eq).trim();
    let v = line.slice(eq + 1).trim();
    if (
      (v.startsWith('"') && v.endsWith('"')) ||
      (v.startsWith("'") && v.endsWith("'"))
    ) {
      v = v.slice(1, -1);
    }
    if (process.env[k] === undefined) process.env[k] = v;
  }
}
loadDotenv(resolve(process.cwd(), ".env.local"));

interface GtFile {
  fields: {
    brand_name: string;
    class_type: string;
    class_category: string;
    abv_percent: number;
    net_contents: { value: number; unit: string };
    producer: unknown;
    country_of_origin: string | null;
  };
}

function toDeclared(gt: GtFile): unknown {
  // Match the bench's `toDeclared` behaviour (bin/labelverify-bench.ts).
  // `country_of_origin: null` is a LEGITIMATE declared value — TTB only
  // requires country marking on imports (27 CFR §4.39 / §5.36) so a
  // US-domestic application that didn't declare a country should still
  // verify. Pass null through to the nullish schema branch in
  // DeclaredFieldsSchema; the verifier will REVIEW or PASS the
  // country_of_origin field depending on what the label shows.
  const f = gt.fields;
  const country =
    typeof f.country_of_origin === "string" && f.country_of_origin.length >= 2
      ? f.country_of_origin
      : null;
  return {
    brand_name: f.brand_name,
    class_type: f.class_type,
    class_category: f.class_category,
    abv_percent: f.abv_percent,
    net_contents: f.net_contents,
    producer: f.producer,
    country_of_origin: country,
  };
}

interface Args {
  imagePath?: string;
  gtPath?: string;
  corpus?: string;
  stem?: string;
  help: boolean;
}

function parseArgs(argv: string[]): Args {
  const a: Args = { help: false };
  const positional: string[] = [];
  for (let i = 2; i < argv.length; i++) {
    const t = argv[i]!;
    if (t === "--help" || t === "-h") a.help = true;
    else if (t === "--corpus") {
      const v = argv[++i];
      if (v === undefined) throw new Error("--corpus requires a path");
      a.corpus = v;
    } else positional.push(t);
  }
  if (a.corpus) {
    if (positional.length === 0) throw new Error("--corpus needs an image stem");
    a.stem = positional[0];
  } else if (positional.length === 2) {
    a.imagePath = positional[0];
    a.gtPath = positional[1];
  } else if (!a.help) {
    throw new Error(
      "Usage: tsx bin/diagnose.ts <image> <gt.json>   OR   --corpus <dir> <stem>",
    );
  }
  return a;
}

function printHelp(): void {
  console.log(`diagnose — single-image verifier diagnostic

Usage:
  tsx bin/diagnose.ts <image-path> <gt-json-path>
  tsx bin/diagnose.ts --corpus <dir> <stem>

Prints the full verifyLabel response for one (image, GT) pair:
  - aggregate verdict + image quality
  - per-field statuses (brand_name, class_type, abv_percent,
    net_contents, producer, country_of_origin)
  - Government Warning subscores (text, caps, bold, size) with
    per-subscore status + confidence + reason
  - review reasons (if any)
  - second-opinion fields (if the second-opinion path fired)
`);
}

async function main(): Promise<void> {
  const args = parseArgs(process.argv);
  if (args.help) {
    printHelp();
    return;
  }

  let imagePath: string;
  let gtPath: string;
  if (args.corpus && args.stem) {
    const root = resolve(args.corpus);
    const labels = join(root, "labels");
    const truths = join(root, "ground-truth");
    const candidates = [`${args.stem}.png`, `${args.stem}.jpg`, `${args.stem}.jpeg`];
    const found = candidates.map((f) => join(labels, f)).find((p) => existsSync(p));
    if (!found)
      throw new Error(`No image found for stem "${args.stem}" in ${labels}`);
    imagePath = found;
    gtPath = join(truths, `${args.stem}.json`);
  } else {
    imagePath = resolve(args.imagePath!);
    gtPath = resolve(args.gtPath!);
  }

  if (!existsSync(imagePath)) throw new Error(`Image not found: ${imagePath}`);
  if (!existsSync(gtPath)) throw new Error(`GT not found: ${gtPath}`);

  const gtRaw = await readFile(gtPath, "utf8");
  const gt = JSON.parse(gtRaw) as GtFile;
  const declared = toDeclared(gt);
  const validated = DeclaredFieldsSchema.safeParse(declared);
  if (!validated.success) {
    console.error("Schema validation failed:");
    console.error(JSON.stringify(validated.error.issues, null, 2));
    process.exit(1);
  }

  const { verifyLabel } = await import("../src/lib/verify");
  const buf = await readFile(imagePath);
  const r = await verifyLabel(buf, validated.data);

  // Print operator-facing report.
  console.log(`Image:        ${imagePath}`);
  console.log(`GT:           ${gtPath}`);
  console.log(`Declared:     ${JSON.stringify(validated.data)}`);
  console.log(``);
  console.log(`VERDICT:      ${r.verdict.toUpperCase()}`);
  console.log(`Image quality: ${r.imageQuality}${r.imageQualityReason ? ` (${r.imageQualityReason})` : ""}`);
  console.log(`Model:        ${r.modelId}${r.modelVersion ? ` (${r.modelVersion})` : ""}${r.fallbackUsed ? ` [fallback: ${r.fallbackUsed}]` : ""}`);
  console.log(``);
  console.log(`Fields:`);
  for (const [name, f] of Object.entries(r.fields)) {
    const reason = f.reason ? ` — ${f.reason}` : "";
    console.log(`  ${name.padEnd(18)} ${(f.status as string).padEnd(7)} (conf ${(f.confidence as number).toFixed(2)})${reason}`);
  }
  console.log(``);
  console.log(`Government Warning (aggregate ${r.governmentWarning.status}, conf ${r.governmentWarning.confidence.toFixed(2)}):`);
  const subs = r.governmentWarning.subscores;
  console.log(`  text  ${subs.text.status.padEnd(7)} (conf ${subs.text.confidence.toFixed(2)})`);
  console.log(`  caps  ${subs.caps.status.padEnd(7)} (conf ${subs.caps.confidence.toFixed(2)})`);
  console.log(`  bold  ${subs.bold.status.padEnd(7)} (conf ${subs.bold.confidence.toFixed(2)})`);
  console.log(`  size  ${subs.size.status.padEnd(7)} (conf ${subs.size.confidence.toFixed(2)})`);
  if (r.governmentWarning.reason) {
    console.log(`  reason: ${r.governmentWarning.reason}`);
  }
  if (r.reviewReasons.length > 0) {
    console.log(``);
    console.log(`Review reasons:`);
    for (const reason of r.reviewReasons) console.log(`  - ${reason}`);
  }
  if (r.secondOpinion) {
    const so = r.secondOpinion;
    console.log(``);
    console.log(`Second opinion (${so.modelId}, agrees=${so.agreesWithPrimary}, ${so.latencyMs}ms):`);
    console.log(`  trigger: ${so.reason}`);
    const sosubs = so.governmentWarning.subscores;
    console.log(`  text  ${sosubs.text.status.padEnd(7)} (conf ${sosubs.text.confidence.toFixed(2)})`);
    console.log(`  caps  ${sosubs.caps.status.padEnd(7)} (conf ${sosubs.caps.confidence.toFixed(2)})`);
    console.log(`  bold  ${sosubs.bold.status.padEnd(7)} (conf ${sosubs.bold.confidence.toFixed(2)})`);
    console.log(`  size  ${sosubs.size.status.padEnd(7)} (conf ${sosubs.size.confidence.toFixed(2)})`);
  }
  console.log(``);
  console.log(`Timings (ms):  preprocess ${r.timings.preprocess}  ocr ${r.timings.ocr}  vision ${r.timings.vision}  matching ${r.timings.matching}  total ${r.timings.total}`);
}

main().catch((err) => {
  console.error((err as Error).message);
  process.exit(1);
});
