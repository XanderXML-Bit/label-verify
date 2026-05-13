// Re-run T6 (Gemini 3.1 Flash Lite, direct SDK) against the routine
// subset and emit per-image, per-field outcomes. Lets the project lead
// see exactly WHICH images the bake-off failed/deferred on, not just
// the aggregate number.
//
// Output: writes JSON to .review/t6-routine-per-image.json AND prints a
// human-readable summary to stdout.

import { readFileSync, existsSync, mkdirSync, writeFileSync, copyFileSync } from "node:fs";
import { readFile } from "node:fs/promises";
import { basename, join } from "node:path";

function loadDotenv(path: string) {
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
    )
      v = v.slice(1, -1);
    const existing = process.env[k];
    if (existing === undefined || existing === "") process.env[k] = v;
  }
}
loadDotenv(".env.local");

async function main() {
  const { preprocessImage } = await import("../src/lib/preprocess");
  const { scoreImage } = await import("../benchmarks/scorer");
  const { selectRoutine } = await import("../benchmarks/routine");
  // Use the full verifyLabel orchestrator so we capture verdict +
  // reviewReasons (which is how deferral shows up). The bake-off
  // scorer only emits correct/incorrect — deferral lives one level up.
  const { verifyLabel } = await import("../src/lib/verify");
  // Also instantiate the bare T6 extractor so we can compare what the
  // BAKE-OFF saw (extractor only, no OCR hint, no orchestrator
  // comparators) against what the orchestrator path produces. The
  // bake-off's 97.6% number is the bare-extractor measurement; the
  // orchestrator path includes OCR-as-hint which (per MODEL-SELECTION
  // §4) actually HURTS the corpus.
  const { findTechnique } = await import("../benchmarks/techniques");
  const t6Factory = findTechnique("T6")!;
  const bareT6 = await t6Factory.build();

  // Load v2 ground-truth.
  const truthDir = "test-data-v2/ground-truth";
  const labelsDir = "test-data-v2/labels";
  const { readdir } = await import("node:fs/promises");
  const files = await readdir(truthDir);
  const truths = await Promise.all(
    files
      .filter((f) => f.endsWith(".json"))
      .map(async (f) => JSON.parse(await readFile(join(truthDir, f), "utf8"))),
  );
  const subset = selectRoutine(truths);
  console.log(`[t6-detail] routine subset = ${subset.length} images`);

  const perImage: any[] = [];
  for (let i = 0; i < subset.length; i++) {
    const gt = subset[i]!;
    const imagePath = join(labelsDir, basename(gt.image));
    const buf = await readFile(imagePath);
    const pre = await preprocessImage(buf);
    const t0 = Date.now();
    // Run the full orchestrator with the ground-truth declared fields.
    // This produces verdict + reviewReasons (deferral signal) AND we
    // separately score against the ground-truth correctness map.
    // v2 ground-truth nests declared fields under `.fields`. Construct
    // a DeclaredFields shape the orchestrator expects (drop the gov-
    // warning sub-object since it's the validator's responsibility,
    // not a declared input).
    const declared = {
      brand_name: gt.fields.brand_name,
      class_type: gt.fields.class_type,
      class_category: gt.fields.class_category,
      abv_percent: gt.fields.abv_percent,
      net_contents: gt.fields.net_contents,
      producer: gt.fields.producer,
      // GT may have country_of_origin === null on US-domestic labels
      // (TTB only requires marking on imports). The DeclaredFields
      // schema requires a string, so coerce null → "USA" for these:
      // the verifier's country comparator handles the null-extracted
      // case via implicit-USA inference from the producer address.
      country_of_origin: gt.fields.country_of_origin ?? "USA",
    };
    const verifyRes = await verifyLabel(buf, declared);
    const latencyMs = Date.now() - t0;
    // ALSO run the bare extractor for the apples-to-apples bake-off
    // measurement. This is the path that scored 97.6% in
    // MODEL-SELECTION §4. The orchestrator-with-OCR-hint path scored
    // 89.3% in the same bake-off (C1), so we expect to see roughly 1-2
    // wrong-field misses here for the routine subset.
    const bareRes = await bareT6.run(pre.buffer);
    const bareScored = await scoreImage(gt, bareRes.fields, {
      width: pre.width,
      height: pre.height,
    });
    const scored = await scoreImage(gt, verifyRes.extracted, {
      width: pre.width,
      height: pre.height,
    });
    perImage.push({
      imageId: gt.id,
      imagePath,
      latencyMs,
      verdict: verifyRes.verdict,
      requiresHumanReview: verifyRes.requiresHumanReview,
      reviewReasons: verifyRes.reviewReasons,
      // BAKE-OFF apples-to-apples measurement (bare extractor, no OCR
      // hint). This is what determines whether the image counts as a
      // miss for the 97.6% headline number.
      bareOutcomes: bareScored.outcomes.map((o: any) => ({
        field: o.field,
        correct: o.correct,
        strata: o.strata,
      })),
      // Orchestrator + OCR-hint measurement (the live verify path).
      // Same scorer, different upstream input — captures what an actual
      // end-user request sees.
      outcomes: scored.outcomes.map((o: any) => ({
        field: o.field,
        correct: o.correct,
        strata: o.strata,
      })),
      warningOutcome: scored.warningOutcome,
    });
    const wrong = scored.outcomes.filter((o: any) => !o.correct).length;
    const bareWrong = bareScored.outcomes.filter((o: any) => !o.correct).length;
    console.log(
      `[t6-detail] [${i + 1}/${subset.length}] ${gt.id}: ${latencyMs}ms verdict=${verifyRes.verdict} bare-wrong=${bareWrong} orchestrator-wrong=${wrong}`,
    );
  }

  mkdirSync(".review", { recursive: true });
  writeFileSync(
    ".review/t6-routine-per-image.json",
    JSON.stringify(perImage, null, 2),
  );

  // Categorise images on THREE axes:
  //   - BAKE-OFF correctness (bare extractor, the 97.6% headline path)
  //   - ORCHESTRATOR correctness (with OCR hint, the live-verify path)
  //   - Verdict (PASS / FAIL / REVIEW) — captures deferral
  const bakeoffWrong = perImage.filter((p) =>
    p.bareOutcomes.some((o: any) => o.correct === false),
  );
  const wrongImages = perImage.filter((p) =>
    p.outcomes.some((o: any) => o.correct === false),
  );
  const deferredImages = perImage.filter((p) => p.verdict === "review");
  const failVerdict = perImage.filter((p) => p.verdict === "fail");
  const passVerdict = perImage.filter((p) => p.verdict === "pass");

  console.log("");
  console.log("=== T6 routine-subset per-image breakdown ===");
  console.log(`Total: ${perImage.length}`);
  console.log(`Verdict PASS:                ${passVerdict.length}`);
  console.log(`Verdict FAIL:                ${failVerdict.length}`);
  console.log(`Verdict REVIEW (deferred):   ${deferredImages.length}`);
  console.log(
    `BAKE-OFF wrong (bare T6):    ${bakeoffWrong.length}/${perImage.length}`,
  );
  console.log(
    `ORCHESTRATOR wrong (OCR+T6): ${wrongImages.length}/${perImage.length}`,
  );
  console.log("");

  if (bakeoffWrong.length > 0) {
    console.log("--- BAKE-OFF: images where bare T6 got ≥1 field WRONG (these are the 2.4% misses from MODEL-SELECTION §4) ---");
    for (const p of bakeoffWrong) {
      const bad = p.bareOutcomes.filter((o: any) => !o.correct);
      console.log(`  ${p.imageId}  (${p.imagePath})  verdict=${p.verdict}`);
      for (const o of bad) {
        console.log(`    [WRONG] field=${o.field} strata=${JSON.stringify(o.strata)}`);
      }
    }
    console.log("");
  }

  if (wrongImages.length > 0) {
    console.log("--- ORCHESTRATOR (with OCR hint): images that produced ≥1 wrong field ---");
    for (const p of wrongImages) {
      const bad = p.outcomes.filter((o: any) => !o.correct);
      console.log(`  ${p.imageId}  (${p.imagePath})  verdict=${p.verdict}`);
      for (const o of bad) {
        console.log(`    [WRONG] field=${o.field} strata=${JSON.stringify(o.strata)}`);
      }
    }
  }
  if (deferredImages.length > 0) {
    console.log("");
    console.log("--- Images the verdict aggregator DEFERRED to REVIEW ---");
    for (const p of deferredImages) {
      const wrong = p.outcomes.filter((o: any) => !o.correct).length;
      const wasActuallyWrong = wrong > 0 ? "true-positive defer" : "false-positive defer (would have been PASS)";
      console.log(
        `  ${p.imageId}  (${p.imagePath})  — ${wasActuallyWrong}, ${wrong} wrong fields`,
      );
      for (const reason of p.reviewReasons.slice(0, 3)) {
        console.log(`    · ${reason}`);
      }
    }
  }

  // Copy two sets of flagged images into separate folders so the
  // project lead can browse each axis independently:
  //   .review/t6-bakeoff-misses/  → bare-extractor wrong (the 97.6% misses)
  //   .review/t6-deferred/        → verdict=review (the orchestrator deferrals)
  const bakeoffDir = ".review/t6-bakeoff-misses";
  const deferredDir = ".review/t6-deferred";
  mkdirSync(bakeoffDir, { recursive: true });
  mkdirSync(deferredDir, { recursive: true });
  for (const p of bakeoffWrong) {
    try {
      copyFileSync(p.imagePath, join(bakeoffDir, basename(p.imagePath)));
    } catch {
      // ignore
    }
  }
  for (const p of deferredImages) {
    try {
      copyFileSync(p.imagePath, join(deferredDir, basename(p.imagePath)));
    } catch {
      // ignore
    }
  }
  console.log("");
  console.log(`Bake-off misses copied to ${bakeoffDir}/  (${bakeoffWrong.length} files)`);
  console.log(`Deferred-to-REVIEW copied to ${deferredDir}/  (${deferredImages.length} files)`);
}

main().catch((e) => {
  console.error("FAIL:", (e as Error).message);
  process.exit(1);
});
