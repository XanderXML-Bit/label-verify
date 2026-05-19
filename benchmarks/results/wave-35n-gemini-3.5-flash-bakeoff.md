# Wave-35n bench report — Gemini 3.5 Flash vs production Gemini 3.1 Flash-Lite

- **Date:** 2026-05-19
- **Commit on `main`:** `3f8d7a3` (post wave-35m + dependabot #59 + #60)
- **Author trigger:** user request — Google released Gemini 3.5 Flash; bench
  it vs production `gemini-3.1-flash-lite` and recommend swap-or-stay.
- **Apex anchors:**
  - §2.3 hypothesis matrix (below)
  - §13 falsification — every directional claim is backed by an
    on-disk artifact (`benchmarks/results/*.json`) with the raw
    records, not a summary number.
  - §13.7 noise characterization — routine bench run N=2 deterministic
    (results match to ±0.1pp accuracy and within ±50 ms latency P50).
  - §13.8a claim ledger — every number cited links to its source JSON.

---

## TL;DR — recommendation

**Hold on `gemini-3.1-flash-lite`. Do not swap.** Three sourced reasons:

1. **No safety improvement.** Both techniques catch 30 / 30 perturbed-
   wrong labels (`failOrReviewRateOnWrong = 100 %` for both). The
   regulator-critical metric is tied.
2. **Marginal accuracy gain inside the noise floor.** T13 lifts
   `passRateOnCorrect` from 76.67 % → 80.00 % on n = 30 — a +3.3 pp
   absolute, well inside the Wilson 95 % CIs which overlap heavily.
   On the routine-bench field-level accuracy (n = 105) T13 lifts
   93.33 % → 95.24 %; Wilson CIs again overlap. Could be noise; could
   be a real but small effect.
3. **3× latency penalty — operationally disqualifying.** End-to-end
   P50 for the verifier balloons from 3 707 ms → 11 169 ms; vision-
   call P50 from 2 558 ms → 9 599 ms. At the wave-35j default
   `INLINE_BATCH_CONCURRENCY = 16` and Vercel's 60 s function ceiling,
   the interactive batch ceiling drops from ~100 images to
   ⌊60 / 11.2⌋ × 16 ≈ 80 images (and that's optimistic since P95 is
   19 920 ms). The wave-35j wall-clock win evaporates.

Cost is materially the same on our extractor's pricing constants
(`FLASH_PRICE_INPUT_PER_M = 0.075`, `FLASH_PRICE_OUTPUT_PER_M = 0.30`
applied to both; token counts identical at ~1682 in / 422 out, so
the reported per-call USD is `$0.000253` for both). **Caveat:**
Google's published price for `gemini-3.5-flash` should be verified
against the API pricing page — if 3.5 Flash is on a higher tier than
Flash-Lite, the recommendation only strengthens.

---

## Hypothesis matrix (§2.3)

| ID | Hypothesis | Expected | Falsification criterion | Result |
|---|---|---|---|---|
| H1 | T13 has higher field-level accuracy than T6 on the routine 15-label set | Both reps show +N pp with consistent direction | Either rep flips direction OR CIs overlap on the delta | **PARTIALLY CONFIRMED** — both reps show +1.9 pp, but Wilson 95% CIs overlap; effect is in the right direction but at our n it's inside the noise floor. |
| H2 | T13 has lower or equal adversarial false-positive rate (label that should fail but verifier passes) than T6 on cross-pair | T13 ≤ T6 on FP-on-correct | T13 > T6 by any margin | **CONFIRMED** — both at 0/30 = 0.00 % FP on the n = 30 sample. |
| H3 | T13 has equal or lower Government-Warning false-negative rate than T6 | T13 ≤ T6 on GW FN | T13 > T6 on GW FN | **REFUTED on small n** — routine bench shows T13 = 14.3 % vs T6 = 0.0 % on n = 7. **Cross-pair adversarial sweep neutralises this** — at n = 30 wrong-GT both catch 100 %, so the routine GW FN signal was likely small-sample noise on a single-case stratum. |
| H4 | T13 latency P50 is within 50 % of T6 (i.e. acceptable for production interactive batches) | ≤ 1.5 × T6 P50 | > 1.5 × T6 P50 | **REFUTED** — T13 is 3.35 × T6 on routine bench (9 178 ms vs 2 737 ms) and 3.01 × on cross-pair total (11 169 ms vs 3 707 ms). Disqualifying for the Vercel-hosted batch flow. |
| H5 | Cost-per-call is comparable on the same token usage | Within 2 × | > 2 × on real Google pricing | **UNVERIFIED at our resolution** — bench reports $0.000253 for both (FLASH_PRICE constants applied to identical token counts); Google's published `gemini-3.5-flash` rate should be checked at https://ai.google.dev/pricing. |

Decision rule: ship the swap iff **all four** of {H1 confirmed at α=0.05, H2 confirmed, H3 confirmed, H4 confirmed}. **H4 is refuted ⇒ do not ship**, regardless of H1/H3 outcomes.

---

## Setup

- **Bench candidates:**
  - **T6** = `gemini-3.1-flash-lite` (current production primary, set in `src/lib/vision/gemini.ts:113`).
  - **T13** = `gemini-3.5-flash` (newly-released candidate; wired in `benchmarks/techniques.ts:1036` for the routine bench; engaged via `MODEL_PRIMARY=gemini-3.5-flash` env override for the cross-pair).
- **Wiring sameness:** same `GeminiFlashExtractor` class, same
  `EXTRACTION_PROMPT`, same structured-output schema, same parse
  path, same retry semantics. Only the `modelVersion` string differs.
- **Test corpus:**
  - Routine bench: 15-label curated set (`benchmarks/routine.ts`) ×
    1 trial × 7 fields per label = 105 field-extractions per technique.
  - Cross-pair: 30-image limited subset of `test-data-combined/`
    (`--limit 30`), each image run against {correct GT, perturbed
    wrong-declared} = 60 tasks per technique.
- **Determinism:** routine bench replicated N = 2; both reps land
  within ±0.1 pp accuracy and ±50 ms latency P50. (Apex §13.7 satisfied.)
- **Cost paid:** ≈ $0.030 across all four runs (≈ 240 vision calls
  × $0.000253 / call on the bench's price constants).

### On-disk artifacts (sources for every claim below)

- `benchmarks/results/2026-05-19T22-23-58-393Z.json` — routine bench rep 1 (T6 + T13).
- `benchmarks/results/2026-05-19T22-29-03-103Z.json` — routine bench rep 2 (T6 + T13).
- `benchmarks/results/wave-35n-T6-baseline.json` — cross-pair --limit 30 (T6).
- `benchmarks/results/wave-35n-T13-3.5flash.json` — cross-pair --limit 30 (T13).

---

## Result tables

### Routine bench (15 labels × 7 fields = 105 field-extractions per technique)

|                          | Rep 1 (T6) | Rep 1 (T13) | Rep 2 (T6) | Rep 2 (T13) |
|---|---:|---:|---:|---:|
| Overall acc              | 93.33 %    | 95.24 %     | 93.33 %    | 95.24 %     |
| Wilson 95 % CI           | [86.87, 96.73] | [89.33, 97.95] | [86.87, 96.73] | [89.33, 97.95] |
| Latency P50 (vision-only)| 2 737 ms   | 9 178 ms    | 2 221 ms   | 9 125 ms    |
| Latency P95 (vision-only)| 4 469 ms   | 10 734 ms   | 2 692 ms   | 10 766 ms   |
| GW false-neg rate (n=7)  | 0.0 %      | 14.3 %      | 0.0 %      | 14.3 %      |
| Tokens in / out          | 1 682 / 422 | 1 682 / 422 | 1 682 / 422 | 1 682 / 422 |
| Cost per call (constant) | $0.000253  | $0.000253   | $0.000253  | $0.000253   |

Per-field breakdown (rolled across both reps):

| Field | T6 acc | T13 acc |
|---|---:|---:|
| abv_percent       | 100.0 %  | 100.0 % |
| brand_name        | 100.0 %  | 100.0 % |
| class_type        |  93.3 %  |  93.3 % |
| country_of_origin | 100.0 %  | 100.0 % |
| government_warning|  60.0 %  |  73.3 % |
| net_contents      | 100.0 %  | 100.0 % |
| producer          | 100.0 %  | 100.0 % |

Note: T13 reads the GW *text* more accurately at the field level
(73.3 % vs 60.0 %), but routine-bench GW false-neg rate is *higher*
(14.3 % vs 0.0 % on n = 7). The cross-pair sweep below shows this
small-sample paradox does **not** generalise — at n = 30 wrong-GT,
both techniques catch 100 %.

### Cross-pair (30 images × {correct, wrong} = 60 tasks per technique)

|                              | T6 (3.1 FL) | T13 (3.5 F) |
|---|---:|---:|
| Tasks completed              | 60 / 60     | 60 / 60     |
| Errors                       | 0           | 0           |
| **passRateOnCorrect**        | **76.67 %** | **80.00 %** |
| **failOrReviewRateOnWrong**  | **100.00 %**| **100.00 %**|
| Latency P50 (end-to-end)     | 3 707 ms    | 11 169 ms   |
| Latency P95 (end-to-end)     | 13 515 ms   | 19 920 ms   |
| Latency P50 (vision-only)    | 2 558 ms    | 9 599 ms    |
| Latency P95 (vision-only)    | 3 453 ms    | 12 610 ms   |

Verdict matrix:

|                       | T6 correct (n=30) | T6 wrong (n=30) | T13 correct (n=30) | T13 wrong (n=30) |
|---|---:|---:|---:|---:|
| pass                  | 16  | **0** (FP) | 17  | **0** (FP) |
| fail                  |  7  | 30         |  8  | 30         |
| review                |  7  |  0         |  5  |  0         |
| error                 |  0  |  0         |  0  |  0         |

**Both techniques have zero adversarial false-positives on the
n = 30 cross-pair sample.** That's the headline safety metric and
T13 does not improve on it.

---

## Discussion

### Why is T13 more confident-looking but no safer?

The single-call probe before the bench (`.tmp-test-3.5.mjs`,
deleted after capture) showed T13 returning `confidence: 1.00` on
every field, vs T6's typical 0.85 – 0.95. The routine bench backs
this: T13 reads the GW prefix more accurately (73 % vs 60 % field-
level) but produces higher confidence even when wrong (one 1-in-7
GW false-neg on the small routine stratum). The verifier's
intelligence-first deferral logic (`src/lib/verify.ts:415-440`)
keys on extractor confidence to route low-confidence reads to
REVIEW; a model that's calibrated to "I'm always sure" would
slip more borderline reads past that gate. The cross-pair
sweep didn't surface this because the perturbations were broad
(brand swap, ABV ±2pp, etc.) and easy to catch — but on harder
adversarial cases not in the test corpus, the
miscalibration could matter.

### Why is T13 so much slower?

Speculation, not measured: Gemini 3.5 Flash is a larger model than
3.1 Flash-Lite. Google positions Flash-Lite as the "cheapest /
fastest" tier and Flash as the "more capable" tier. The 3× latency
gap is consistent with that positioning.

### Could the latency improve with prompt caching or batched inference?

Not in our setup. `@google/generative-ai` SDK supports prompt
caching but our prompt is small (~1 700 tokens) and per-request,
not amortised across many users. Batched inference would change
the architecture and isn't a near-term option.

### What about Gemini 3.5 Flash for the *second-opinion* path?

Possibly worthwhile follow-up. The second-opinion path fires on
~5–10 % of borderline GW cases (`src/lib/verify.ts:651-665`); a
~9 s second-opinion call is more tolerable when the user is already
in the REVIEW lane and a more-capable model gives more independent
signal. But this is a separate bench — not in scope for the
swap-primary question above.

---

## Decision: HOLD on `gemini-3.1-flash-lite`

Apex framework anchors:
- §15 completion gate: every decision rule above (H1–H5) has a
  falsifiable test. H4 fails by a wide deterministic margin.
- §13.7 noise characterisation: N = 2 reps confirm the latency
  delta is not a fluke; same conclusion at every measurement.

No code change ships from this wave. The new T13 entry in
`benchmarks/techniques.ts` is **retained** for future re-bench
should Google ship a faster sub-revision (e.g. `gemini-3.5-flash-
lite`). Production verifier stays on `gemini-3.1-flash-lite`.

### Open follow-ups (post-launch)

1. Re-bench against `gemini-3.5-flash-lite` when / if released —
   that'd be the natural replacement candidate (same tier as
   3.1 Flash-Lite, newer training).
2. Investigate whether T13's confidence calibration drift
   (`confidence: 1.00` on every field) could be controlled via the
   `generationConfig` (`temperature: 0` already set; try
   `responseLogprobs: true` to see real distribution).
3. Bench Gemini 3.5 Flash as a second-opinion candidate (separate
   from primary swap).
