# Benchmark Harness

Picks the extractor that ships in production. Four contenders (per
[`docs/APPROACH.md`](../docs/APPROACH.md) §2.1):

| ID | Technique | What it is |
|----|-----------|------------|
| T1 | Tesseract OCR baseline | Pure-OCR text extraction + regex/heuristic field parsing. No network. The honest baseline. |
| T4 | GPT-4o-mini Vision | Hosted VLM via `src/lib/vision/openai.ts`. Requires `OPENAI_API_KEY`. |
| T6 | Gemini 2.0 Flash Vision | Hosted VLM via `src/lib/vision/gemini.ts`. Requires `GOOGLE_API_KEY`. |
| C1 | OCR + Vision combined | T1 OCR text fed into the T6 prompt via `ExtractorContext.ocrText`. Requires `GOOGLE_API_KEY`. |

Out-of-scope candidates (Tesseract+ML classifier, AWS Textract, Claude Vision,
etc.) are enumerated in `docs/APPROACH.md` §2.2.

## Running

```sh
# Smoke run — first 20 images, 1 trial each. T1 has no API-key dependency.
npx tsx benchmarks/run.ts --smoke --corpus test-data-v2 --technique T1

# Full run, all four techniques, 3 trials per image (per APPROACH.md §5 step 3).
GOOGLE_API_KEY=... OPENAI_API_KEY=... npx tsx benchmarks/run.ts

# Specific technique, against the larger v2 corpus.
GOOGLE_API_KEY=... npx tsx benchmarks/run.ts --corpus test-data-v2 --technique T6
```

CLI flags:
- `--smoke` — first 20 images, 1 trial per image.
- `--corpus <dir>` — root of corpus (must contain `labels/` and `ground-truth/`). Defaults to `test-data`; falls back to `test-data-v2` if `test-data` is empty.
- `--technique <id>` — restrict to one technique. Repeatable. Defaults to all four.

Per-image timeout is 60 s; network failures are logged and counted but do not
stall the run. A technique whose prerequisite (API key, sibling extractor
module) is missing is skipped with a warning rather than aborting the run.

## Output

Two files per run, under `benchmarks/results/<iso-timestamp>.{json,md}`:

- **`.json`** — full machine-readable summary. Per-technique: Wilson 95% CI
  on overall accuracy, stratified `beverage_type × condition × field` table,
  Gov-Warning false-negative rate (the regulator-dangerous direction —
  predicted PASS on a non-compliant label), OOD split (`source === "real"`
  vs synthetic/degraded), latency P50/P95 from the per-trial log, image
  failure count.
- **`.md`** — reviewer-readable overall-accuracy table, OOD split table, and
  the pairwise McNemar grid (statistic, p-value, discordant counts) so the
  significance call lives in the report rather than the JSON.

Console output: one line per technique with accuracy, P50 latency, failure
count.

## Code layout

- `run.ts` — CLI entry point + loop + aggregation + report writing.
- `techniques.ts` — `BUILTIN_TECHNIQUES`: four factories returning `TechniqueRunner` instances.
- `scorer.ts` — `scoreImage(gt, extracted, dims)` → per-field `PerItemOutcome[]` + `PerItemWarningOutcome`. Reuses the production comparators in `src/lib/matching/` and the validator in `src/lib/validation/government-warning-validator.ts`.
- `score.ts` — pure-stats helpers (Wilson, McNemar, stratify, FN-rate, OOD partition).
