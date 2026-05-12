# AI Corpus Cross-Validation Report

Oracle: `gemini-3.1-pro-preview` via `GeminiProExtractor`. Each image preprocessed via `preprocessImage()` (sharp).
Run at: 2026-05-12T03:45:19.395Z
Wall-clock: 23.7s (0.39 min)

## Summary

- Images validated: **1**
- Strict matches: **0** (0.0%)
- Drift: **1**
- Errors: **0**
- Tokens: 1,640 in / 425 out
- Total cost: **$0.0042**

## Per-field drift counts

| Field | Drift count |
| --- | ---: |
| `country_of_origin` | 1 |

## Per-image drift

| ID | Usage tier | Status | Drifted fields |
| --- | --- | --- | --- |
| ai-label-0001 | strictBenchmarkReady | DRIFT | `country_of_origin` |

## Drift detail (per-image diffs)

### ai-label-0001

- **country_of_origin** — expected `USA`, got `null`. Extractor returned null country_of_origin.


## Commentary

- Of the 1 `strictBenchmarkReady` images, 0 fully agree with the oracle.
- Of the 0 `robustnessOnly` images, 0 fully agree (drift here is expected; these are kept for OCR/vision stress, not strict ground truth).

## Costing

Pricing reference: Gemini Pro tier (<200K context) per `src/lib/vision/gemini.ts` = $1.25 / 1M input + $5.00 / 1M output tokens.
Computed at the per-image level using the SDK's reported `usageMetadata`, summed: **$0.0042**.
