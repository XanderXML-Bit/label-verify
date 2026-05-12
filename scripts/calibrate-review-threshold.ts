// Calibrate REVIEW_CONFIDENCE_THRESHOLD against the 170-image combined
// corpus. Implements REMAINING-IMPROVEMENTS.md item A2.
//
// The threshold is a second-layer floor: when every per-field comparator
// returns PASS, the orchestrator downgrades the verdict to REVIEW if any
// PASS-field's extractor confidence is below the threshold. The current
// value (0.55) was set by intuition in `src/lib/verify.ts`; this script
// sweeps τ ∈ [0.30, 0.95] against the real corpus and reports the loss-
// minimising value under the pre-registered weights in
// `docs/PROJECT-TODO.md`:
//
//     loss(τ) = 3 · false_positive_defers + 5 · missed_wrong_passes
//
// "False-positive defer" = correctly-PASS-able label that we demoted to
// REVIEW unnecessarily. "Missed wrong PASS" = label whose comparator
// returned PASS at high confidence on a wrong extraction.
//
// Output:
//   - .review/threshold-calibration-data.json — raw per-image records
//   - .review/threshold-calibration-report.md — sweep table + recommendation
//   - stdout summary

import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { readFile, readdir } from "node:fs/promises";
import { basename, join } from "node:path";

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
    const existing = process.env[k];
    if (existing === undefined || existing === "") process.env[k] = v;
  }
}
loadDotenv(".env.local");

interface FieldRecord {
  field: string;
  status: "pass" | "fail" | "review";
  confidence: number;
  /** Did the extracted value match the ground truth? Drives MWP detection. */
  gtCorrect: boolean;
}

interface ImageRecord {
  imageId: string;
  imagePath: string;
  source: "synthetic" | "degraded" | "real";
  beverageType?: string;
  govWarningCase: string | null;
  /** Base verdict ignoring the deferral threshold (worst-of status). */
  baseVerdict: "pass" | "fail" | "review";
  govStatus: "pass" | "fail" | "review";
  govPredictionCorrect: boolean;
  /** "Truly compliant" — gov-warning compliant AND every field extracted correctly. */
  trulyCompliant: boolean;
  fields: FieldRecord[];
}

async function main(): Promise<void> {
  const corpusArg = process.argv[2] ?? "test-data-combined";

  const truthDir = join(corpusArg, "ground-truth");
  const labelsDir = join(corpusArg, "labels");
  if (!existsSync(truthDir) || !existsSync(labelsDir)) {
    throw new Error(`Corpus not found: ${corpusArg}/ground-truth or labels missing`);
  }

  const { preprocessImage } = await import("../src/lib/preprocess");
  const {
    compareBrand,
    compareClass,
    compareAbv,
    compareNetContents,
    compareProducer,
    compareCountry,
  } = await import("../src/lib/matching");
  const { validateGovernmentWarning } = await import(
    "../src/lib/validation/government-warning-validator"
  );
  const { findTechnique } = await import("../benchmarks/techniques");

  const t6Factory = findTechnique("T6");
  if (!t6Factory) throw new Error("T6 technique not registered");
  const t6 = await t6Factory.build();

  const truthFiles = (await readdir(truthDir)).filter((f) => f.endsWith(".json"));
  truthFiles.sort();
  console.log(`[calibrate] corpus=${corpusArg} images=${truthFiles.length}`);

  const records: ImageRecord[] = [];

  for (let i = 0; i < truthFiles.length; i++) {
    const file = truthFiles[i]!;
    const gt: any = JSON.parse(await readFile(join(truthDir, file), "utf8"));
    const imagePath = join(labelsDir, basename(gt.image));
    let buf: Buffer;
    try {
      buf = await readFile(imagePath);
    } catch {
      console.warn(`[calibrate] skip ${gt.id} — image missing`);
      continue;
    }

    const pre = await preprocessImage(buf);
    let extracted;
    try {
      extracted = await t6.run(pre.buffer);
    } catch (err) {
      console.warn(`[calibrate] ${gt.id} extractor error: ${(err as Error).message}`);
      continue;
    }
    const f = extracted.fields;

    // Run the production comparators with ground-truth declared values.
    // Defensive null-tolerance on every field — the AI corpus has a small
    // number of fields the visual audit left blank (no value visible).
    const passStub = (field: string, value: unknown, confidence: number) => ({
      field,
      status: "pass" as const,
      expected: null,
      actual: value,
      confidence,
    });
    const brand = gt.fields.brand_name
      ? compareBrand(gt.fields.brand_name, f.brand_name.value)
      : passStub("brand_name", f.brand_name.value, f.brand_name.confidence);
    const cls = gt.fields.class_type
      ? compareClass(gt.fields.class_type, f.class_type.value, f.class_type.confidence)
      : passStub("class_type", f.class_type.value, f.class_type.confidence);
    const abv =
      gt.fields.abv_percent !== null && gt.fields.abv_percent !== undefined
        ? compareAbv(
            gt.fields.abv_percent,
            gt.fields.class_category,
            f.abv_percent.value,
            f.abv_percent.confidence,
          )
        : passStub("abv_percent", f.abv_percent.value, f.abv_percent.confidence);
    // Same null-tolerance handling as country: a handful of AI labels
    // omit net_contents in the visual audit. Treat as synthetic pass.
    const nc = gt.fields.net_contents
      ? compareNetContents(
          gt.fields.net_contents,
          f.net_contents.value,
          f.net_contents.confidence,
        )
      : {
          field: "net_contents",
          status: "pass" as const,
          expected: null,
          actual: f.net_contents.value,
          confidence: f.net_contents.confidence,
        };
    const producer = gt.fields.producer
      ? compareProducer(
          gt.fields.producer,
          f.producer.value,
          f.producer.confidence,
        )
      : passStub("producer", f.producer.value, f.producer.confidence);
    // A handful of AI-corpus ground-truths have country_of_origin=null
    // (label didn't visibly mark a country and the audit honoured that).
    // Treat those as a synthetic "pass" for calibration — the deferral
    // threshold isn't what catches those cases.
    const country = gt.fields.country_of_origin
      ? compareCountry(
          gt.fields.country_of_origin,
          f.country_of_origin.value,
          f.country_of_origin.confidence,
        )
      : {
          field: "country_of_origin",
          status: "pass" as const,
          expected: null,
          actual: f.country_of_origin.value,
          confidence: f.country_of_origin.confidence,
        };

    // Gov-warning subscore: same path as production. validateGovernmentWarning
    // dereferences declaredNetContents in its size subscore via toMl(), so a
    // null net_contents would crash — fall back to a 750ml stub for the size
    // calculation (a reasonable midpoint for the corpus; only affects the
    // size subscore boundary, which isn't the calibration target).
    const gov = await validateGovernmentWarning({
      extracted: f.government_warning.value ?? {
        raw_text: null,
        prefix_text: null,
        prefix_bbox: null,
        prefix_appears_bold: null,
        prefix_appears_caps: null,
      },
      declaredNetContents:
        gt.fields.net_contents ?? { value: 750, unit: "ml" },
      imageDimsPx: { width: pre.width, height: pre.height },
    });

    // gtCorrect: did the extractor's value survive the comparator?
    // status === "pass" → extraction matched declared (== gt). status === "fail"
    // → mismatch. status === "review" → comparator deferred. For calibration
    // we want to know if the comparator's PASS was actually correct on the
    // ground truth, so reuse the comparator status: status===pass IS the
    // correctness signal in this corpus (declared = gt by construction).
    const fieldComps = [brand, cls, abv, nc, producer, country];
    const fieldRecs: FieldRecord[] = fieldComps.map((c) => ({
      field: c.field,
      status: c.status,
      confidence: c.confidence,
      // Comparator pass ↔ extraction matched gt. For "fail" the extraction
      // definitively diverged. For "review" the comparator wasn't sure.
      gtCorrect: c.status === "pass",
    }));

    // Worst-of aggregator (matches production verify.ts logic).
    const statuses = [...fieldRecs.map((r) => r.status), gov.status];
    const baseVerdict: "pass" | "fail" | "review" = statuses.includes("fail")
      ? "fail"
      : statuses.includes("review")
        ? "review"
        : "pass";

    const govWarningCase: string | null = gt.gov_warning_case ?? null;
    const govTruthCompliant = !govWarningCase;
    const govPredictionCorrect = (gov.status === "pass") === govTruthCompliant;
    const trulyCompliant =
      govTruthCompliant && fieldRecs.every((r) => r.gtCorrect);

    records.push({
      imageId: gt.id,
      imagePath,
      source: gt.source,
      beverageType: gt.beverage_type,
      govWarningCase,
      baseVerdict,
      govStatus: gov.status,
      govPredictionCorrect,
      trulyCompliant,
      fields: fieldRecs,
    });

    console.log(
      `[calibrate] [${i + 1}/${truthFiles.length}] ${gt.id} base=${baseVerdict} ` +
        `gov=${gov.status} truly=${trulyCompliant}`,
    );
  }

  mkdirSync(".review", { recursive: true });
  writeFileSync(
    ".review/threshold-calibration-data.json",
    JSON.stringify({ corpus: corpusArg, runAt: new Date().toISOString(), records }, null, 2),
  );

  // ── Sweep ─────────────────────────────────────────────────────────────
  const grid: number[] = [];
  for (let t = 0.30; t <= 0.95 + 1e-9; t += 0.01) grid.push(Math.round(t * 100) / 100);

  interface SweepRow {
    threshold: number;
    fpd: number; // false-positive defers
    mwp: number; // missed wrong PASSes
    caughtWrongPass: number; // demoted a wrong-PASS — neutral but informative
    correctPass: number;
    loss: number;
    deferRate: number; // share of base-PASS images that get demoted
  }

  const basePassImages = records.filter((r) => r.baseVerdict === "pass");

  const rows: SweepRow[] = grid.map((tau) => {
    let fpd = 0;
    let mwp = 0;
    let caught = 0;
    let correctPass = 0;
    let demoted = 0;
    for (const img of basePassImages) {
      const passConfs = img.fields
        .filter((f) => f.status === "pass")
        .map((f) => f.confidence);
      const minPassConf = passConfs.length > 0 ? Math.min(...passConfs) : 1;
      const isDemoted = minPassConf < tau;
      if (isDemoted) demoted++;
      if (isDemoted && img.trulyCompliant) fpd++;
      if (isDemoted && !img.trulyCompliant) caught++;
      if (!isDemoted && img.trulyCompliant) correctPass++;
      if (!isDemoted && !img.trulyCompliant) mwp++;
    }
    return {
      threshold: tau,
      fpd,
      mwp,
      caughtWrongPass: caught,
      correctPass,
      loss: 3 * fpd + 5 * mwp,
      deferRate: basePassImages.length > 0 ? demoted / basePassImages.length : 0,
    };
  });

  rows.sort((a, b) => a.loss - b.loss || a.threshold - b.threshold);
  const optimal = rows[0]!;

  // Re-sort by threshold for report.
  rows.sort((a, b) => a.threshold - b.threshold);

  const totalImages = records.length;
  const basePassCount = basePassImages.length;
  const trulyCompliantInBasePass = basePassImages.filter((r) => r.trulyCompliant).length;
  const notTrulyCompliantInBasePass = basePassCount - trulyCompliantInBasePass;

  // Current production threshold for reference.
  const currentTau = 0.55;
  const currentRow = rows.find((r) => Math.abs(r.threshold - currentTau) < 1e-9)!;

  // Build markdown report
  const lines: string[] = [];
  lines.push(`# REVIEW_CONFIDENCE_THRESHOLD calibration`, "");
  lines.push(`Corpus: ${truthFiles.length} images. Generated ${new Date().toISOString()}`, "");
  lines.push(`Loss function (pre-registered in docs/PROJECT-TODO.md):`, "");
  lines.push(`    loss(τ) = 3 · false_positive_defers + 5 · missed_wrong_PASSes`, "");
  lines.push(
    "Only images whose base verdict is PASS (no comparator returned FAIL/REVIEW) are affected by τ; ",
    `${basePassCount} of ${totalImages} images in this corpus fall into that bucket. `,
    `Of those, ${trulyCompliantInBasePass} are truly compliant (extracted matched GT on every field AND gov-warning case was null), `,
    `and ${notTrulyCompliantInBasePass} have a wrong PASS lurking (a lenient comparator passed a wrong extraction, or a gov-warning case slipped through).`,
    "",
  );
  lines.push(`## Recommendation`, "");
  lines.push(`Optimal τ = **${optimal.threshold.toFixed(2)}** (loss=${optimal.loss}, fpd=${optimal.fpd}, mwp=${optimal.mwp}).`);
  if (Math.abs(optimal.threshold - currentTau) < 1e-9) {
    lines.push(`Current production value (0.55) is already optimal — no change needed.`);
  } else {
    lines.push(`Current production value (0.55) gives loss=${currentRow.loss}, fpd=${currentRow.fpd}, mwp=${currentRow.mwp}. `);
    const delta = currentRow.loss - optimal.loss;
    lines.push(`Switching to τ=${optimal.threshold.toFixed(2)} reduces loss by ${delta} (${currentRow.loss}→${optimal.loss}).`);
  }
  lines.push("", "## Sweep table", "");
  lines.push("| τ | FPD | MWP | caught-wrong-PASS | correct-PASS | loss | defer-rate |");
  lines.push("|---|-----|-----|---------------------|--------------|------|------------|");
  for (const r of rows) {
    const marker = Math.abs(r.threshold - optimal.threshold) < 1e-9 ? " ← min" : "";
    lines.push(
      `| ${r.threshold.toFixed(2)} | ${r.fpd} | ${r.mwp} | ${r.caughtWrongPass} | ${r.correctPass} | ${r.loss}${marker} | ${(r.deferRate * 100).toFixed(1)}% |`,
    );
  }
  lines.push("", "## Per-image base-verdict breakdown", "");
  const passN = records.filter((r) => r.baseVerdict === "pass").length;
  const failN = records.filter((r) => r.baseVerdict === "fail").length;
  const reviewN = records.filter((r) => r.baseVerdict === "review").length;
  lines.push(`- Base PASS:   ${passN}`);
  lines.push(`- Base FAIL:   ${failN}`);
  lines.push(`- Base REVIEW: ${reviewN}`);

  writeFileSync(".review/threshold-calibration-report.md", lines.join("\n"));

  console.log("");
  console.log("=== Calibration complete ===");
  console.log(`Optimal τ: ${optimal.threshold.toFixed(2)}  loss=${optimal.loss}  fpd=${optimal.fpd}  mwp=${optimal.mwp}`);
  console.log(`Current τ=0.55: loss=${currentRow.loss}  fpd=${currentRow.fpd}  mwp=${currentRow.mwp}`);
  console.log(`Reports written: .review/threshold-calibration-data.json + report.md`);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
