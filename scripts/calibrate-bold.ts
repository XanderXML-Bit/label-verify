// Calibration: run Tesseract + measureRelativeBold across every B1/B2/B3/B4
// and "compliant null" sample in test-data-v2, then print the metric
// distribution per case. Used to pick the BOLD_RATIO_PASS / BOLD_RATIO_FAIL
// constants in government-warning.ts.
//
// Run with: npx tsx scripts/calibrate-bold.ts

import { readFile, readdir } from "node:fs/promises";
import { join } from "node:path";
import { tesseractEngine } from "../src/lib/ocr/tesseract";
import { preprocessImage } from "../src/lib/preprocess";
import {
  findPrefixWords,
  findBodyWords,
  measureRelativeBold,
} from "../src/lib/validation/bold-size";

interface Truth {
  id: string;
  gov_warning_case: string | null;
  fields: {
    government_warning?: { prefix_bold?: boolean };
  };
}

interface Row {
  id: string;
  case: string;
  ratio: number;
  confidence: number;
  prefixBoldFlag: number | null;
  bodyBoldFlag: number | null;
}

async function main(): Promise<void> {
  const root = process.cwd();
  const truthDir = join(root, "test-data-v2", "ground-truth");
  const labelsDir = join(root, "test-data-v2", "labels");

  const files = (await readdir(truthDir)).filter((f) => f.endsWith(".json"));
  // Pick relevant cases: B1, B2, B3, B4, and "compliant" (gov_warning_case === null).
  // Prefer `syn-` samples for compliant — they are clean (no degradation
  // noise) so the ratio they produce is the upper-bound truth for the
  // metric.
  const interesting: { id: string; case: string }[] = [];
  for (const f of files) {
    const t = JSON.parse(
      await readFile(join(truthDir, f), "utf8"),
    ) as Truth;
    const c = t.gov_warning_case;
    if (c === null) interesting.push({ id: t.id, case: "compliant" });
    else if (c === "B1" || c === "B2" || c === "B3" || c === "B4") {
      interesting.push({ id: t.id, case: c });
    }
  }
  // Prefer syn- samples (clean) over deg- (degraded) for compliant baseline.
  interesting.sort((a, b) => {
    if (a.case === "compliant" && b.case === "compliant") {
      const aSyn = a.id.startsWith("syn-") ? 0 : 1;
      const bSyn = b.id.startsWith("syn-") ? 0 : 1;
      return aSyn - bSyn;
    }
    return 0;
  });
  // Cap "compliant" at 15 samples — enough for a distribution.
  const compliantCap = 15;
  let cn = 0;
  const filtered = interesting.filter((x) => {
    if (x.case !== "compliant") return true;
    cn++;
    return cn <= compliantCap;
  });

  const rows: Row[] = [];
  for (const item of filtered) {
    try {
      const raw = await readFile(join(labelsDir, `${item.id}.png`));
      // Upscale the (small) synthetic 900×1200 labels to 1800-wide before
      // OCR so Tesseract reliably segments the prefix line. Production
      // preprocessImage caps at 1600 but the corpus is already <=1600 so
      // skipping enlargement; we override that here for calibration only.
      const pre = await preprocessImage(raw, { maxEdge: 1800 });
      const upscaled = await import("sharp").then((m) =>
        m
          .default(raw)
          .resize({ width: 1800, withoutEnlargement: false })
          .png()
          .toBuffer(),
      );
      const ocr = await tesseractEngine.run(upscaled);
      void pre;
      const prefix = findPrefixWords(ocr.words);
      const body = findBodyWords(ocr.words, prefix);
      if (prefix.length === 0 || body.length === 0) {
        console.log(
          `[skip] ${item.id} (${item.case}): no prefix/body OCR — words=${ocr.words.length}`,
        );
        continue;
      }
      const m = await measureRelativeBold(upscaled, prefix, body);
      rows.push({
        id: item.id,
        case: item.case,
        ratio: m.ratio,
        confidence: m.confidence,
        prefixBoldFlag: m.fontBoldFractionPrefix,
        bodyBoldFlag: m.fontBoldFractionBody,
      });
      console.log(
        `[${item.case}] ${item.id} ratio=${m.ratio.toFixed(3)} conf=${m.confidence.toFixed(2)} prefixBold=${m.fontBoldFractionPrefix} bodyBold=${m.fontBoldFractionBody}`,
      );
    } catch (e) {
      console.log(`[err] ${item.id}: ${(e as Error).message}`);
    }
  }

  console.log("\n=== Distribution by case ===");
  const byCase = new Map<string, number[]>();
  for (const r of rows) {
    if (!byCase.has(r.case)) byCase.set(r.case, []);
    byCase.get(r.case)!.push(r.ratio);
  }
  for (const [c, vs] of byCase) {
    vs.sort((a, b) => a - b);
    const n = vs.length;
    const min = vs[0]!;
    const max = vs[n - 1]!;
    const median = vs[Math.floor(n / 2)]!;
    const mean = vs.reduce((s, x) => s + x, 0) / n;
    console.log(
      `${c.padEnd(10)} n=${n} min=${min.toFixed(3)} median=${median.toFixed(3)} mean=${mean.toFixed(3)} max=${max.toFixed(3)}`,
    );
  }
}

main().then(
  () => process.exit(0),
  (e) => {
    console.error(e);
    process.exit(1);
  },
);
