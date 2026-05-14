#!/usr/bin/env tsx
// bin/measure-prefix-ratios.ts
//
// Empirical OCR-derived prefix-ratio measurement on a list of images.
// Same px-to-mm conversion the validator uses (long-edge ÷ assumed
// label height for declared net contents), MAX-bbox-height across the
// prefix words (matches `measureSizeMm` in `src/lib/validation/bold-size.ts`).
//
// Used to design size-threshold experiments without burning Gemini API
// calls — runs Tesseract + the px→mm conversion locally.

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
import {
  labelHeightMmFor,
  toMl,
} from "../src/lib/matching/net-contents";
import {
  MIN_TYPE_HEIGHT_MM_LARGE,
  MIN_TYPE_HEIGHT_MM_SMALL,
  SMALL_CONTAINER_THRESHOLD_ML,
} from "../src/lib/validation/government-warning";

interface GtFile {
  fields: {
    net_contents: { value: number; unit: "fl_oz" | "ml" | "L" | "cl" } | null;
  };
  gov_warning_case?: string | null;
}

const targets = process.argv.slice(2);
if (targets.length === 0) {
  console.error("Usage: tsx bin/measure-prefix-ratios.ts <img-filename> [...]");
  process.exit(1);
}

(async () => {
  for (const img of targets) {
    try {
      const stem = img.replace(/\.\w+$/, "");
      const ext = img.match(/\.(jpg|jpeg|png)$/i)?.[0] ?? ".jpg";
      const imgPath = `test-data-combined/labels/${stem}${ext}`;
      const gtPath = `test-data-combined/ground-truth/${stem}.json`;

      const buf = await readFile(imgPath);
      const gt = JSON.parse(readFileSync(gtPath, "utf8")) as GtFile;
      const nc = gt.fields.net_contents ?? { value: 12, unit: "fl_oz" as const };

      const pre = await preprocessImage(buf);
      const ocr = await tesseractEngine.run(pre.buffer);
      const longEdgePx = Math.max(pre.width, pre.height);
      const labelMm = labelHeightMmFor(nc);
      const pxPerMm = longEdgePx / labelMm;
      const isSmall = toMl(nc) <= SMALL_CONTAINER_THRESHOLD_ML;
      const minMm = isSmall ? MIN_TYPE_HEIGHT_MM_SMALL : MIN_TYPE_HEIGHT_MM_LARGE;

      const govWords = ocr.words.filter((w) =>
        /GOVERNMENT|WARNING/i.test(w.text),
      );
      if (govWords.length === 0) {
        console.log(
          `${stem}\tno_gw_words\tcase=${gt.gov_warning_case ?? "?"}`,
        );
        continue;
      }
      const maxH = govWords.reduce((m, w) => Math.max(m, w.bbox.height), 0);
      const prefixMm = maxH / pxPerMm;
      const ratio = prefixMm / minMm;
      console.log(
        `${stem.padEnd(26)} ratio=${ratio.toFixed(3)} prefixMm=${prefixMm.toFixed(2)} minMm=${minMm} case=${gt.gov_warning_case ?? "?"}`,
      );
    } catch (e) {
      console.log(`${img}\tERROR\t${(e as Error).message}`);
    }
  }
})();
