#!/usr/bin/env tsx
import { existsSync, readFileSync } from "node:fs";
import { readFile } from "node:fs/promises";
import { resolve } from "node:path";

function loadDotenv(p: string): void {
  if (!existsSync(p)) return;
  for (const raw of readFileSync(p, "utf8").split(/\r?\n/)) {
    const line = raw.trim();
    if (!line || line.startsWith("#")) continue;
    const eq = line.indexOf("=");
    if (eq < 0) continue;
    const k = line.slice(0, eq).trim();
    let v = line.slice(eq + 1).trim();
    if ((v.startsWith('"') && v.endsWith('"')) || (v.startsWith("'") && v.endsWith("'"))) v = v.slice(1, -1);
    if (process.env[k] === undefined) process.env[k] = v;
  }
}
loadDotenv(resolve(process.cwd(), ".env.local"));

import { preprocessImage } from "../src/lib/preprocess";
import { tesseractEngine } from "../src/lib/ocr/tesseract";
import { findPrefixWords, findBodyWords } from "../src/lib/validation/bold-size";

(async () => {
  for (const img of process.argv.slice(2)) {
    try {
      const stem = img.replace(/\.\w+$/, "");
      // Try both extensions
      let buf: Buffer | null = null;
      for (const ext of [".jpg", ".png"]) {
        const p = `test-data-combined/labels/${stem}${ext}`;
        if (existsSync(p)) {
          buf = await readFile(p);
          break;
        }
      }
      if (!buf) {
        console.log(`${stem.padEnd(28)} FILE_NOT_FOUND`);
        continue;
      }
      const gtRaw = readFileSync(`test-data-combined/ground-truth/${stem}.json`, "utf8");
      const gt = JSON.parse(gtRaw) as { gov_warning_case?: string | null };

      const pre = await preprocessImage(buf);
      const ocr = await tesseractEngine.run(pre.buffer);

      const prefix = findPrefixWords(ocr.words);
      if (prefix.length === 0) {
        console.log(`${stem.padEnd(28)} no_prefix case=${gt.gov_warning_case ?? "?"}`);
        continue;
      }
      const prefixMax = prefix.reduce((m, w) => Math.max(m, w.bbox.height), 0);
      const body = findBodyWords(ocr.words, prefix);
      if (body.length === 0) {
        console.log(`${stem.padEnd(28)} prefix=${prefixMax}px no_body case=${gt.gov_warning_case ?? "?"}`);
        continue;
      }
      const sorted = body.map(w => w.bbox.height).sort((a, b) => a - b);
      const bodyMedian = sorted[Math.floor(sorted.length / 2)] ?? 0;
      const ratio = prefixMax / bodyMedian;
      console.log(`${stem.padEnd(28)} prefix=${prefixMax}px body_med=${bodyMedian}px ratio=${ratio.toFixed(2)} n_body=${body.length} case=${gt.gov_warning_case ?? "?"}`);
    } catch (e) {
      console.log(`${img}\tERROR\t${(e as Error).message}`);
    }
  }
})();
