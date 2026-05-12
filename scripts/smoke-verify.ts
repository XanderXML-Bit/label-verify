// Quick end-to-end smoke test: read one v2 corpus label + its ground truth,
// run it through verifyLabel with a real Gemini call, and print the verdict.
// Confirms the live integration works before committing to a full benchmark
// run. Not part of the test suite — invoke explicitly.

import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { verifyLabel } from "../src/lib/verify";
import type { DeclaredFields } from "../src/lib/types";

async function main(): Promise<void> {
  const args = process.argv.slice(2);
  const idArg = args.find((a) => !a.startsWith("--"));
  const id = idArg ?? "syn-beer-0001";
  const corpus = args.includes("--corpus")
    ? args[args.indexOf("--corpus") + 1]!
    : "test-data-v2";

  const root = process.cwd();
  const imagePath = join(root, corpus, "labels", `${id}.png`);
  const truthPath = join(root, corpus, "ground-truth", `${id}.json`);

  console.log(`[smoke] corpus=${corpus} id=${id}`);

  const image = await readFile(imagePath);
  const truth = JSON.parse(await readFile(truthPath, "utf8")) as {
    fields: DeclaredFields;
    gov_warning_case: string | null;
  };

  const declared: DeclaredFields = {
    brand_name: truth.fields.brand_name,
    class_type: truth.fields.class_type,
    class_category: truth.fields.class_category,
    abv_percent: truth.fields.abv_percent,
    net_contents: truth.fields.net_contents,
    producer: truth.fields.producer,
    country_of_origin: truth.fields.country_of_origin,
  };

  console.log(`[smoke] declared brand=${declared.brand_name} class=${declared.class_type} abv=${declared.abv_percent}% case=${truth.gov_warning_case ?? "PASS"}`);

  const t0 = performance.now();
  const result = await verifyLabel(image, declared, { visionTimeoutMs: 30_000 });
  const elapsed = performance.now() - t0;

  console.log(`[smoke] wall-clock ${(elapsed / 1000).toFixed(2)}s`);
  console.log(`[smoke] verdict=${result.verdict}  imageQuality=${result.imageQuality}`);
  console.log(`[smoke] gov-warning=${result.governmentWarning.status} (text=${result.governmentWarning.subscores.text.status}, caps=${result.governmentWarning.subscores.caps.status}, bold=${result.governmentWarning.subscores.bold.status}, size=${result.governmentWarning.subscores.size.status})`);
  console.log(`[smoke] per-field:`);
  console.log(`  brand: ${result.fields.brand_name.status}`);
  console.log(`  class: ${result.fields.class_type.status}`);
  console.log(`  abv:   ${result.fields.abv_percent.status}`);
  console.log(`  net:   ${result.fields.net_contents.status}`);
  console.log(`  prod:  ${result.fields.producer.status}`);
  console.log(`  ctry:  ${result.fields.country_of_origin.status}`);
  console.log(`[smoke] timings: ${JSON.stringify(result.timings)}`);

  // Sanity check: for a PASS sample, verdict should be pass.
  if (truth.gov_warning_case === null && result.verdict !== "pass") {
    console.warn(`[smoke] WARN: ground truth says PASS, model says ${result.verdict}`);
  }

  process.exit(0);
}

main().catch((err: unknown) => {
  console.error("[smoke] FAILED:", err);
  process.exit(1);
});
