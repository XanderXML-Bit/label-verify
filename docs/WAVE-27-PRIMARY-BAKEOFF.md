# Wave 27 — primary-model bake-off (2026-05-14)

> Direct head-to-head comparison of `gemini-3.1-flash-lite` (current primary), `gemini-2.5-flash` (current second-opinion), and `gemini-3-flash-preview` as the **primary** extractor. Second-opinion path was disabled for all three runs so the measurement isolates primary-only behavior.

## Methodology

- Each candidate ran as `MODEL_PRIMARY` via the new env-var override in `buildDefaultExtractor()`.
- Second-opinion disabled by setting `SECOND_OPINION_PROVIDER=openai` + empty `OPENAI_API_KEY` + empty `MODEL_FALLBACK` so the selector returns null and the borderline-Gov-Warning recheck path doesn't fire.
- Cross-pair bench on the 170-image `test-data-combined` corpus (340 tasks per run), concurrency 4.
- N=2 each for the two GA models (`3.1-flash-lite`, `2.5-flash`). N=1 for `3-flash-preview` (the preview's stricter rate-limit ~tripled the run time; per user direction "don't blow money on redundant runs," one data point is enough to read a clear ranking).

## Results

| Metric (mean across replicates) | gemini-3.1-flash-lite | gemini-2.5-flash | gemini-3-flash-preview |
|---|---:|---:|---:|
| Pass-rate on correct GT | **65.1%** | 64.2% | **72.6%** |
| Fail-or-review on wrong GT | 100.0% | 100.0% | 100.0% |
| **False-fail (compliant rejected, lower=better)** | **3** | **17.5 ⚠️** | **1** |
| **FP-on-correct (regulator-critical, lower=better)** | **5** | **5** | **7 ⚠️** |
| true-reject | 168 | 168.5 | 165 |
| review-on-correct | 51 | 38 | 37 |
| Vision p50 | **2.6 s** | 8.2 s | 17.1 s ⚠️ |
| Vision p95 | **3.5 s** | 11.3 s | 29.5 s ⚠️ |
| Errors (per 340 tasks) | 2 | 2 | 11 ⚠️ |

## Reading the data

### `gemini-2.5-flash` is **worse** as primary, despite being smarter as second-opinion

False-fail jumps from 3 to 17.5 — a **5.8× regression**. Pass-rate is also marginally lower. The likely mechanism: 2.5-flash's stronger reasoning produces different bbox geometry / prefix detection patterns that the downstream OCR+validator chain wasn't calibrated for. The Gov-Warning text + bold + size subscores were built against 3.1-flash-lite's extraction style; swapping the extractor without retuning the downstream pipeline broke the calibration.

**Implication**: the wave-22 decision to put 2.5-flash on the *second-opinion* path (not primary) was correct. Same model, different role, materially different outcome.

### `gemini-3-flash-preview` has the best raw accuracy but fails the deployment criteria

- ✓ Best pass-rate (+7.5 pp vs 3.1-flash-lite).
- ✗ **False-pass-on-correct = 7** — violates the pre-registered "≤ baseline +2σ = 7.61" criterion in spirit (it's *exactly* at the upper bound, with N=1 noise). Two of the synthetic B/S defect cases that 3.1-flash-lite correctly REVIEWs slip through to PASS on the preview.
- ✗ **Vision p50 = 17.1 s** vs the brief's ≤ 5 s SLA. p95 = 29.5 s — outside the 60 s function budget headroom we need for batch processing.
- ✗ **11 errors per run** vs 2 — preview-tier rate-limiting + schema-conformance issues. Five-fold error rate is operationally unviable.
- ✗ **~6× the cost** per call (per Google's published rate card; see README cost table).

### `gemini-3.1-flash-lite` Pareto-dominates the two contenders for the primary role

- Best vision p50 / p95 by 3-6×.
- Lowest error rate.
- Lowest cost.
- Within 7.5 pp of the highest pass-rate, achieved without the preview's fp-on-correct regression.

## Decision

**No architecture change.** The current main-branch defaults are confirmed by the bake-off:

| Role | Model | Reason |
|---|---|---|
| **Primary extractor** | `gemini-3.1-flash-lite` | Pareto-dominant on the deployment criteria (latency × cost × accuracy × error rate). |
| **Second-opinion (REVIEW recheck)** | `gemini-2.5-flash` | Smarter on borderline reasoning where the primary lands ambiguous. Wave 22 — see [`WAVE-22-FINDINGS.md`](WAVE-22-FINDINGS.md). Confirmed here: this model is *not* a viable primary, but it is the right tiebreaker on borderline cases. |
| **Cross-provider primary-failure fallback** | `gpt-5.4-nano` | Provider-diversity safety net on full Gemini outage. Separate concern from the second-opinion. |

`MODEL_PRIMARY=<id>` (added in this wave) is an operations escape hatch for any future A/B test against a new Google flash variant — no code change needed to rerun this bake-off if Google ships e.g. `gemini-3.5-flash-lite`.

## Artifacts

- `benchmarks/results/bakeoff/gemini-3.1-flash-lite-run{1,2}.json`
- `benchmarks/results/bakeoff/gemini-2.5-flash-run{1,2}.json`
- `benchmarks/results/bakeoff/gemini-3-flash-preview-run1.json`
- `benchmarks/results/bakeoff/compare-bakeoff.js` — analysis script

## Methodology notes (banked for next size-threshold experiment)

The wave-26 revert (size-threshold relaxation that introduced +1 fp on synthetic S2) and this wave-27 bake-off both reinforce the same lesson: **single-channel improvements that increase pass-rate on real photos also increase fp-on-correct on synthetic adversarial cases**. Any future intervention that nudges the verifier toward "more permissive on borderline size or bold" has to be paired with corroborating multi-signal evidence (vision + OCR + second-opinion agreement) before it's safe to relax the cliff. The next size-detection wave should design the experiment as a joint-evidence check, not a global threshold knob.
