// Benchmark runner. Implementation lands in Phase 2 of TODO.md.
//
// Per APPROACH.md §2.1, the v1 benchmark scope is exactly four contenders:
//   T1 Tesseract OCR baseline
//   T4 GPT-4o-mini Vision
//   T6 Gemini 2.0 Flash Vision
//   C1 OCR + Vision (T1 + T6 or T4)
//
// Per TEST-STRATEGY.md §7a, every run produces:
//   - Stratified accuracy (beverage × condition × field) with Wilson 95% CI
//   - McNemar's test for each pairwise comparison
//   - Per-field FN rate for Government Warning
//   - Separate OOD column for real labels
//   - Cost USD / 1k labels per technique (from ExtractorResult.cost)
//   - Each run records: model version, prompt hash, image set hash
//
// Output: benchmarks/results/<iso-timestamp>.{json,md}

const smoke = process.argv.includes("--smoke");

async function main() {
  console.warn(`[bench] mode=${smoke ? "smoke" : "full"} — runner not yet implemented.`);
  console.warn("See TODO.md Phase 2.");
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
