# Benchmark harness

The harness compares extraction techniques against the same labelled images.
The [model selection notes](../docs/MODEL-SELECTION.md) describe the full candidate set and decision criteria.

| ID | Technique | Requirement |
| --- | --- | --- |
| T1 | Tesseract optical character recognition and field parsing | No model API key |
| T4 | GPT-4o-mini vision | `OPENAI_API_KEY` |
| T6 | Gemini 3.1 Flash Lite vision | `GOOGLE_API_KEY` |
| C1 | Tesseract text passed to the vision extractor | `GOOGLE_API_KEY` |

## Run a benchmark

Run the local OCR baseline on the same subset as CI. Tesseract may fetch its language data on the first run.

```sh
npm run bench:routine -- --corpus test-data-v2 --technique T1
```

Use `npm run bench:smoke -- --corpus test-data-v2 --technique T1` for the first 20 labels instead.
To compare hosted extractors, configure provider keys as described in the [deployment guide](../docs/DEPLOYMENT.md).

| Flag | Effect |
| --- | --- |
| `--corpus <dir>` | Read `labels/` and `ground-truth/` from this directory. The default is `test-data-combined`. |
| `--technique <id>` | Select a technique. Repeat the flag to select more than one. |
| `--routine` | Use the curated 15-label subset. |
| `--smoke` | Use the first 20 labels. |
| `--trials <n>` | Set the number of trials per image. |
| `--bake-off` | Include the extended candidate set. |

The runner skips a technique if its prerequisites are missing. It reports per-image timeouts as failures and continues.

## Read the results

The runner writes a Markdown summary, a JSON summary, and per-image JSON to `benchmarks/results/`.
The reports include per-field accuracy with Wilson 95% confidence intervals, warning false negatives, and latency.
The Markdown report includes pairwise McNemar tests for techniques that share scored observations.

- [Runner](run.ts) selects the corpus, runs the techniques, and writes the reports.
- [Scorer](scorer.ts) applies the production field comparators and Government Warning validator.
- [Statistics](score.ts) computes confidence intervals, strata, and pairwise tests.

See the [corpus map](../docs/CORPORA.md) for fixture layout, the [protocol](../docs/BENCH-PROTOCOL.md) for scoring, and the [experiment log](../docs/EXPERIMENTS.md) for recorded outcomes.

## Review recorded false passes

In the [recorded cross-pair run](results/wave35-supplemental-crops/baseline-run1.json), each case below expected Fail with correct application data. All three returned Pass.

| Label | Case | Government Warning defect in the ground truth |
| --- | --- | --- |
| [`deg-beer-0012.png`](../test-data-combined/ground-truth/deg-beer-0012.json) | B1 | Regular-weight prefix on a perspective-distorted label |
| [`syn-beer-0016.png`](../test-data-combined/ground-truth/syn-beer-0016.json) | B3 | Medium-weight prefix |
| [`syn-spirits-0013.png`](../test-data-combined/ground-truth/syn-spirits-0013.json) | S1 | Prefix below the minimum type size |

The run saved declared fields and verdicts. Offline replay of these failures requires the extracted fields and warning measurements from those same calls, which the run did not save.
