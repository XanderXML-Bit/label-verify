# AI Corpus Cross-Validation Report

Oracle: `gemini-3.1-pro-preview` via `GeminiProExtractor`. Each image preprocessed via `preprocessImage()` (sharp).
Run at: 2026-05-12T04:06:06.438Z
Wall-clock: 1241.2s (20.69 min)

## Summary

- Images validated: **50**
- Strict matches: **3** (6.0%)
- Drift: **43**
- Errors: **4**
- Tokens: 75,484 in / 18,699 out
- Total cost: **$0.1878**

## Per-field drift counts

| Field | Drift count |
| --- | ---: |
| `country_of_origin` | 43 |
| `government_warning.raw_text` | 2 |
| `government_warning.text_matches_regulation` | 1 |

## Per-image drift

| ID | Usage tier | Status | Drifted fields |
| --- | --- | --- | --- |
| ai-label-0001 | strictBenchmarkReady | DRIFT | `country_of_origin` |
| ai-label-0002 | strictBenchmarkReady | DRIFT | `country_of_origin` |
| ai-label-0003 | strictBenchmarkReady | DRIFT | `country_of_origin` |
| ai-label-0004 | strictBenchmarkReady | DRIFT | `country_of_origin` |
| ai-label-0005 | strictBenchmarkReady | DRIFT | `country_of_origin` |
| ai-label-0006 | robustnessOnly | ERROR | _error: aborted_ |
| ai-label-0007 | strictBenchmarkReady | DRIFT | `country_of_origin` |
| ai-label-0008 | robustnessOnly | DRIFT | `country_of_origin` |
| ai-label-0009 | strictBenchmarkReady | DRIFT | `country_of_origin` |
| ai-label-0010 | strictBenchmarkReady | DRIFT | `country_of_origin` |
| ai-label-0011 | strictBenchmarkReady | DRIFT | `country_of_origin` |
| ai-label-0012 | strictBenchmarkReady | DRIFT | `country_of_origin`, `government_warning.raw_text` |
| ai-label-0013 | robustnessOnly | DRIFT | `country_of_origin` |
| ai-label-0014 | robustnessOnly | DRIFT | `country_of_origin` |
| ai-label-0015 | robustnessOnly | DRIFT | `country_of_origin` |
| ai-label-0016 | strictBenchmarkReady | DRIFT | `country_of_origin` |
| ai-label-0017 | strictBenchmarkReady | DRIFT | `country_of_origin` |
| ai-label-0018 | strictBenchmarkReady | DRIFT | `country_of_origin` |
| ai-label-0019 | strictBenchmarkReady | DRIFT | `country_of_origin` |
| ai-label-0020 | strictBenchmarkReady | DRIFT | `country_of_origin` |
| ai-label-0021 | strictBenchmarkReady | DRIFT | `country_of_origin` |
| ai-label-0022 | strictBenchmarkReady | DRIFT | `country_of_origin` |
| ai-label-0023 | strictBenchmarkReady | DRIFT | `country_of_origin` |
| ai-label-0024 | strictBenchmarkReady | ERROR | _error: aborted_ |
| ai-label-0025 | strictBenchmarkReady | DRIFT | `country_of_origin` |
| ai-label-0026 | strictBenchmarkReady | DRIFT | `country_of_origin` |
| ai-label-0027 | strictBenchmarkReady | DRIFT | `country_of_origin` |
| ai-label-0028 | strictBenchmarkReady | DRIFT | `country_of_origin` |
| ai-label-0029 | strictBenchmarkReady | ERROR | _error: aborted_ |
| ai-label-0030 | robustnessOnly | DRIFT | `country_of_origin` |
| ai-label-0031 | robustnessOnly | DRIFT | `country_of_origin` |
| ai-label-0032 | strictBenchmarkReady | ERROR | _error: aborted_ |
| ai-label-0033 | robustnessOnly | DRIFT | `country_of_origin` |
| ai-label-0034 | strictBenchmarkReady | DRIFT | `country_of_origin` |
| ai-label-0035 | strictBenchmarkReady | DRIFT | `country_of_origin` |
| ai-label-0036 | strictBenchmarkReady | DRIFT | `country_of_origin` |
| ai-label-0037 | strictBenchmarkReady | DRIFT | `country_of_origin` |
| ai-label-0038 | strictBenchmarkReady | DRIFT | `country_of_origin` |
| ai-label-0039 | robustnessOnly | MATCH | — |
| ai-label-0040 | strictBenchmarkReady | DRIFT | `country_of_origin` |
| ai-label-0041 | strictBenchmarkReady | MATCH | — |
| ai-label-0042 | strictBenchmarkReady | DRIFT | `country_of_origin` |
| ai-label-0043 | strictBenchmarkReady | DRIFT | `country_of_origin` |
| ai-label-0044 | strictBenchmarkReady | DRIFT | `country_of_origin` |
| ai-label-0045 | robustnessOnly | MATCH | — |
| ai-label-0046 | robustnessOnly | DRIFT | `country_of_origin` |
| ai-label-0047 | robustnessOnly | DRIFT | `country_of_origin` |
| ai-label-0048 | strictBenchmarkReady | DRIFT | `country_of_origin` |
| ai-label-0049 | robustnessOnly | DRIFT | `country_of_origin` |
| ai-label-0050 | robustnessOnly | DRIFT | `country_of_origin`, `government_warning.text_matches_regulation`, `government_warning.raw_text` |

## Drift detail (per-image diffs)

### ai-label-0001

- **country_of_origin** — expected `USA`, got `null`. Extractor returned null country_of_origin.

### ai-label-0002

- **country_of_origin** — expected `USA`, got `null`. Extractor returned null country_of_origin.

### ai-label-0003

- **country_of_origin** — expected `USA`, got `null`. Extractor returned null country_of_origin.

### ai-label-0004

- **country_of_origin** — expected `USA`, got `null`. Extractor returned null country_of_origin.

### ai-label-0005

- **country_of_origin** — expected `USA`, got `null`. Extractor returned null country_of_origin.

### ai-label-0007

- **country_of_origin** — expected `null`, got `null`. Extractor returned null country_of_origin.

### ai-label-0008

- **country_of_origin** — expected `USA`, got `null`. Extractor returned null country_of_origin.

### ai-label-0009

- **country_of_origin** — expected `USA`, got `null`. Extractor returned null country_of_origin.

### ai-label-0010

- **country_of_origin** — expected `USA`, got `null`. Extractor returned null country_of_origin.

### ai-label-0011

- **country_of_origin** — expected `USA`, got `null`. Extractor returned null country_of_origin.

### ai-label-0012

- **country_of_origin** — expected `USA`, got `EE. UU.`. Alias-aware country mismatch.
- **government_warning.raw_text** — expected `ADVERTENCIA DEL GOBIERNO: Spanish-only government warning visible; canonical English warning is absent.`, got `ADVERTENCIA DEL GOBIERNO:
(1) Según el Cirujano General, las mujeres no
deben beber bebidas alcohólicas durante el
embarazo porque el consumo de alcohol
puede causar defectos de nacimiento.
(2) El ...`. Raw warning text drifts >8% from ground-truth string.

### ai-label-0013

- **country_of_origin** — expected `USA`, got `null`. Extractor returned null country_of_origin.

### ai-label-0014

- **country_of_origin** — expected `USA`, got `null`. Extractor returned null country_of_origin.

### ai-label-0015

- **country_of_origin** — expected `USA`, got `null`. Extractor returned null country_of_origin.

### ai-label-0016

- **country_of_origin** — expected `null`, got `null`. Extractor returned null country_of_origin.

### ai-label-0017

- **country_of_origin** — expected `USA`, got `null`. Extractor returned null country_of_origin.

### ai-label-0018

- **country_of_origin** — expected `USA`, got `null`. Extractor returned null country_of_origin.

### ai-label-0019

- **country_of_origin** — expected `USA`, got `null`. Extractor returned null country_of_origin.

### ai-label-0020

- **country_of_origin** — expected `USA`, got `null`. Extractor returned null country_of_origin.

### ai-label-0021

- **country_of_origin** — expected `USA`, got `null`. Extractor returned null country_of_origin.

### ai-label-0022

- **country_of_origin** — expected `USA`, got `null`. Extractor returned null country_of_origin.

### ai-label-0023

- **country_of_origin** — expected `USA`, got `null`. Extractor returned null country_of_origin.

### ai-label-0025

- **country_of_origin** — expected `USA`, got `null`. Extractor returned null country_of_origin.

### ai-label-0026

- **country_of_origin** — expected `USA`, got `null`. Extractor returned null country_of_origin.

### ai-label-0027

- **country_of_origin** — expected `USA`, got `null`. Extractor returned null country_of_origin.

### ai-label-0028

- **country_of_origin** — expected `USA`, got `null`. Extractor returned null country_of_origin.

### ai-label-0030

- **country_of_origin** — expected `USA`, got `null`. Extractor returned null country_of_origin.

### ai-label-0031

- **country_of_origin** — expected `USA`, got `null`. Extractor returned null country_of_origin.

### ai-label-0033

- **country_of_origin** — expected `USA`, got `null`. Extractor returned null country_of_origin.

### ai-label-0034

- **country_of_origin** — expected `USA`, got `null`. Extractor returned null country_of_origin.

### ai-label-0035

- **country_of_origin** — expected `USA`, got `null`. Extractor returned null country_of_origin.

### ai-label-0036

- **country_of_origin** — expected `USA`, got `null`. Extractor returned null country_of_origin.

### ai-label-0037

- **country_of_origin** — expected `USA`, got `null`. Extractor returned null country_of_origin.

### ai-label-0038

- **country_of_origin** — expected `USA`, got `null`. Extractor returned null country_of_origin.

### ai-label-0040

- **country_of_origin** — expected `USA`, got `null`. Extractor returned null country_of_origin.

### ai-label-0042

- **country_of_origin** — expected `USA`, got `null`. Extractor returned null country_of_origin.

### ai-label-0043

- **country_of_origin** — expected `USA`, got `null`. Extractor returned null country_of_origin.

### ai-label-0044

- **country_of_origin** — expected `Mexico`, got `Product of Mexico`. Alias-aware country mismatch.

### ai-label-0046

- **country_of_origin** — expected `USA`, got `null`. Extractor returned null country_of_origin.

### ai-label-0047

- **country_of_origin** — expected `USA`, got `null`. Extractor returned null country_of_origin.

### ai-label-0048

- **country_of_origin** — expected `USA`, got `null`. Extractor returned null country_of_origin.

### ai-label-0049

- **country_of_origin** — expected `USA`, got `null`. Extractor returned null country_of_origin.

### ai-label-0050

- **country_of_origin** — expected `USA`, got `null`. Extractor returned null country_of_origin.
- **government_warning.text_matches_regulation** — expected `true`, got `false`. Canonical-warning agreement disagrees (expected true, extracted false).
- **government_warning.raw_text** — expected `GOVERNMENT WARNING: (1) According to the Surgeon General, women should not drink alcoholic beverages during pregnancy because of the risk of birth defects. (2) Consumption of alcoholic beverages im...`, got `GOVERNMENT WARNING: (1) According to the Surghneral, women should not drink alcoholic beverages duiing pregnency because of risk risls of birth defects. (2) Cosunmpoiton of alcoholice beverragens i...`. Raw warning text drifts >8% from ground-truth string.


## Commentary

- Of the 36 `strictBenchmarkReady` images, 1 fully agree with the oracle.
- Of the 14 `robustnessOnly` images, 2 fully agree (drift here is expected; these are kept for OCR/vision stress, not strict ground truth).

## Costing

Pricing reference: Gemini Pro tier (<200K context) per `src/lib/vision/gemini.ts` = $1.25 / 1M input + $5.00 / 1M output tokens.
Computed at the per-image level using the SDK's reported `usageMetadata`, summed: **$0.1878**.
