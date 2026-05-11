// Benchmark runner. Implementation lands in Phase 2 of TODO.md.
// Wires every Extractor in techniques/ against the corpus in test-data/
// and writes results/<timestamp>.json + .md.

const smoke = process.argv.includes("--smoke");

async function main() {
  // eslint-disable-next-line no-console
  console.log(`[bench] mode=${smoke ? "smoke" : "full"} — runner not yet implemented.`);
  // eslint-disable-next-line no-console
  console.log("See TODO.md Phase 2.");
}

main().catch((err) => {
  // eslint-disable-next-line no-console
  console.error(err);
  process.exit(1);
});
