#!/usr/bin/env tsx
// bin/diagnose-batch.ts
//
// Batched single-process diagnose — shares one Tesseract worker + one
// sharp instance across N images. Each `tsx bin/diagnose.ts` call paid
// ~30-60s of cold-start (WASM init, native module load) per invocation;
// running 4-7 of them serially in a shell loop made it intractable.
// This version loops in-process so the worker stays hot.
//
// Usage:
//   tsx bin/diagnose-batch.ts --corpus <dir> <stem> [<stem> ...]

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
    net_contents: { value: number; unit: string } | null;
    producer: unknown;
    country_of_origin: string | null;
  };
}

function toDeclared(gt: GtFile): unknown {
  const f = gt.fields;
  if (f.net_contents === null || f.net_contents === undefined) return null;
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

async function main(): Promise<void> {
  const argv = process.argv;
  let corpus = "";
  const stems: string[] = [];
  for (let i = 2; i < argv.length; i++) {
    const t = argv[i]!;
    if (t === "--corpus") corpus = argv[++i] ?? "";
    else stems.push(t);
  }
  if (!corpus || stems.length === 0) {
    console.error("Usage: tsx bin/diagnose-batch.ts --corpus <dir> <stem> [<stem> ...]");
    process.exit(2);
  }
  const root = resolve(corpus);
  const labels = join(root, "labels");
  const truths = join(root, "ground-truth");

  const { verifyLabel } = await import("../src/lib/verify");

  for (const stem of stems) {
    const candidates = [`${stem}.png`, `${stem}.jpg`, `${stem}.jpeg`];
    const imagePath = candidates.map((f) => join(labels, f)).find((p) => existsSync(p));
    const gtPath = join(truths, `${stem}.json`);
    if (!imagePath || !existsSync(gtPath)) {
      console.log(`=== ${stem} === MISSING`);
      continue;
    }
    const gt = JSON.parse(await readFile(gtPath, "utf8")) as GtFile;
    const declared = toDeclared(gt);
    if (!declared) {
      console.log(`=== ${stem} === SKIPPED (GT lacks net_contents)`);
      continue;
    }
    const validated = DeclaredFieldsSchema.safeParse(declared);
    if (!validated.success) {
      console.log(`=== ${stem} === SCHEMA-FAIL: ${validated.error.issues[0]?.message}`);
      continue;
    }
    const t0 = Date.now();
    let r;
    try {
      r = await verifyLabel(await readFile(imagePath), validated.data);
    } catch (err) {
      console.log(`=== ${stem} === THROW: ${(err as Error).message}`);
      continue;
    }
    const elapsed = Date.now() - t0;
    const subs = r.governmentWarning.subscores;
    console.log(
      `=== ${stem} === verdict=${r.verdict} | gw.aggregate=${r.governmentWarning.status} | text=${subs.text.status} caps=${subs.caps.status} bold=${subs.bold.status}(c${subs.bold.confidence.toFixed(2)}) size=${subs.size.status}(c${subs.size.confidence.toFixed(2)}) | reason="${r.governmentWarning.reason ?? ""}" | ${elapsed}ms`,
    );
    // Field statuses summary.
    const failingFields = Object.entries(r.fields)
      .filter(([, f]) => f.status !== "pass")
      .map(([k, f]) => `${k}=${f.status}`);
    if (failingFields.length > 0) {
      console.log(`    fields-not-pass: ${failingFields.join(", ")}`);
    }
    if (r.reviewReasons.length > 0) {
      console.log(`    reviewReasons: ${r.reviewReasons.join(" | ")}`);
    }
  }
}

main().catch((err) => {
  console.error((err as Error).message);
  process.exit(1);
});
