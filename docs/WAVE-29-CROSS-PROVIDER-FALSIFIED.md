# Wave 29 — cross-provider second-opinion A/B (hypothesis FALSIFIED)

> Retrospective `RETROSPECTIVE-2026-05-14.md` §A2 hypothesised that the wave-22 same-provider second-opinion (Gemini 2.5 Flash) was a calibration loss vs the pre-wave-22 cross-provider (OpenAI GPT-5.4-nano), per published 2025 calibration literature on diverse-foundation ensembling. This wave tested that hypothesis empirically. **The hypothesis is falsified on this corpus**: the cross-provider second-opinion catches 1 additional adversarial false-pass but degrades wrong-GT rejection sharpness on 7 cases.

## Methodology

- Branched from main after wave-28b shipped (commit `a91bac8`).
- N=1 cross-pair bench with `SECOND_OPINION_PROVIDER=openai`, `MODEL_FALLBACK=gpt-5.4-nano` (default).
- No code change. Pure env-var flip via the wave-22 selector (`src/lib/vision/second-opinion.ts`).
- Compared cell-by-cell against wave-28b (identical commit, only the env var differs).

## Pre-registered hypothesis

> Cross-provider second-opinion (OpenAI GPT-5.4-nano) will catch ≥1 additional adversarial bold-fallback false-pass without degrading `compliant.*` metrics or `fail-or-review-on-wrong` beyond noise.

## Result (N=1)

### Wave 29 vs wave 28b cell diff (all 11 cells that changed)

| Diff | Count |
|---|---:|
| `true-reject` → `review-on-wrong` | **7** |
| `true-pass` → `review-on-correct` | 2 |
| `false-pass-on-correct` → `review-on-correct` | 1 (deg-beer-0012, B1 case) |
| `review-on-correct` → `true-pass` | 1 |

### Stratified buckets (wave-29 vs wave-28b)

| Stratum × bucket | Wave 28b | Wave 29 | Δ |
|---|---:|---:|---:|
| compliant.fp-on-correct | 0 | 0 | 0 ✓ |
| compliant.false-fail | 1 | 1 | 0 ✓ |
| compliant.true-pass | 40 | 40 | 0 |
| compliant.review-on-correct | 31 | 31 | 0 |
| **adversarial.fp-on-correct** | 6 | **5** | **−1 (favorable)** |
| adversarial.review-on-correct | 6 | 7 | +1 |
| **true-reject** | 168 | **161** | **−7 (UNFAVORABLE)** |
| **review-on-wrong** | 1 | **8** | **+7** (paired with true-reject loss) |
| quality.true-pass | 8 | 7 | −1 |
| quality.review-on-correct | 2 | 3 | +1 |
| pass-rate-on-correct | 71.6% | 71.0% | −0.6 pp |
| fail-or-review-on-wrong | 100.0% | 100.0% | unchanged |

## Interpretation

Same finding as wave-22's original A/B (which is why we picked Gemini 2.5 Flash for the second-opinion in the first place): OpenAI is **less decisive on wrong-GT cases** than Gemini 2.5 Flash. Where Gemini 2.5 Flash agrees with the primary's confident rejection of wrong-GT, OpenAI second-opinion produces enough disagreement to demote the verdict from REJECT to REVIEW. The fail-or-review-rate-on-wrong stays at 100% because both REJECT and REVIEW count, but the operational impact is +7 manual-review burden per 170-image batch.

The +1 adversarial fp catch is real (`deg-beer-0012`, a B1 bold defect), but the corpus-wide net change is unfavorable: −1 fp + 7 wrong-reviews = +6 review-burden units against a corpus where review-burden was already the chronic complaint.

The retrospective's theoretical claim (diverse-foundation ensembling buys calibration) is technically correct, but the EMPIRICAL effect on this corpus is dominated by OpenAI's different style on wrong-GT cases, not by the wins on adversarial corroboration. Wave-22's same-provider choice is correct for this corpus.

## Why wave-22 found different numbers

Wave-22's bench compared (gpt-5.4-nano as second-opinion) vs (gemini-2.5-flash as second-opinion) and showed Gemini-2.5 gave +3.7 true-reject / −3.8 review-on-wrong (sharper rejection). That same effect, reversed direction, is what we see here: switching BACK to OpenAI loses 7 true-rejects and gains 7 review-on-wrong. Consistent with the wave-22 finding.

## Decision

**Do not ship.** Stratified criterion result:
- compliant.* hard criteria pass.
- adversarial.fp-on-correct improvement is real (−1).
- BUT true-reject loss (−7) is a meaningful operational degradation that the stratified criterion did not gate on. Adding wrong-GT degradation to the criterion would gate this out.

Branch `experiment/wave-29-cross-provider-secondopinion` will be deleted. The wave-22 default (`SECOND_OPINION_PROVIDER` unset → Gemini 2.5 Flash) remains correct.

## Hypothesis update (per Apex §13.8a claim ledger)

The retrospective's claim that "cross-provider second-opinion is a calibration win" is updated to: **theoretically sound but empirically dominated by other effects on this corpus**. The `SECOND_OPINION_PROVIDER=openai` env-var flip remains available for operators in environments where the wrong-GT review-burden tradeoff favors cross-provider diversity (e.g. deployments with low wrong-GT volume).

## Possible follow-up (not pursued this session)

A narrower intervention — fire OpenAI **only** on the bold-fallback-only-pass path (not general GW REVIEW), as a tiebreaker on top of the existing primary + Gemini 2.5 Flash — would isolate the +1 adversarial fp benefit without the wrong-GT degradation. Cost: 1 extra OpenAI call on ~5–10% of verifications, plus modest code complexity. Defer to a future wave if/when adversarial.fp-on-correct becomes the binding constraint.

## Artifacts

- `benchmarks/results/wave29-run1.json` — full per-image trace (kept on this branch for the record; not merged to main).
- This document.
