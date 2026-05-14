# Wave 25 — null-extraction safety net (recover deg-beer-0001 false-fail)

> Recorded 2026-05-13. Targeted intervention for the partial Cluster-C false-fails identified in the wave-22 diagnosis. The wave-25 safety net handles the case where the extractor confidently returns `null` on a mandatory COLA field but reads other fields cleanly.

## 1. Hypothesis (pre-registered)

> When the FAIL verdict is driven solely by null-extraction comparators (status=fail + confidence ≤ 0.05) and the Gov-Warning subscore is not FAIL, upgrade FAIL → REVIEW with a "could not read X from the submitted image" reason. The reviewer can disambiguate "field genuinely absent" (compliance issue) vs "field obscured in this photo" (re-shoot needed).

This is sister-logic to the existing §5b `imageQuality === "bad"` safety net. The §5b net misses null-extraction cases because the image-quality calculation explicitly filters null-valued fields (so legitimate absences like `country_of_origin` on US-domestic labels don't drag quality down). When brand or class is null but other fields read confidently, imageQuality stays "good" and FAIL ships untouched.

## 2. Acceptance criterion (regulator-critical, pre-registered)

`false-pass-on-correct` mean over N=3 runs must stay within baseline `mean + 2σ = 7.61`.

## 3. Implementation

| File | Change |
|---|---|
| `src/lib/verify.ts` | Added §5c null-extraction safety net after §5b. Fires when the only failing comparators have confidence ≤ 0.05 (the null-sentinel pattern) AND the Gov-Warning isn't FAIL. Upgrades verdict FAIL → REVIEW with a "could not read [fields] from the submitted image" review reason. |
| `src/tests/verify.test.ts` | 3 new orchestrator tests: FAIL → REVIEW on null class_type, FAIL stays FAIL when a real-content mismatch coexists, PASS never downgraded. |

Risk-bounded: never downgrades PASS; never overrides a real-content FAIL (a comparator that returns fail at confidence > 0.05 — meaning the extractor returned a non-null value that doesn't match declared — still drives the FAIL).

## 4. Result (N=3 cross-pair bench)

| Bucket | Baseline ±2σ (N=8) | wave-24 (N=3) | wave-25 (N=3) | Δ vs wave-24 | Verdict |
|---|---:|---:|---:|---:|---|
| true-pass | 39.3 ±14.0 | 38 | 38 | 0 | ≈ same |
| **false-fail** | **11.9 ±0.7** | 4 | **3** | **−1.0** | **↓ outside −2σ (cumulative −8.9)** |
| review-on-correct | 41.3 ±15.4 | 50 | 51 | +1.0 | deg-beer-0001 moved here |
| **false-pass-on-correct** | 4.6 ±3.0 | 5 | **5** | 0 | ✓ **PASS** acceptance |
| true-fail | 72 | 72 | 72 | 0 | deterministic |
| error-on-correct | 1 | 1 | 1 | 0 | deterministic |
| true-reject | 164.3 ±3.1 | 168 | 168 | 0 | wave-22 inherited |
| review-on-wrong | 4.8 ±3.1 | 1 | 1 | 0 | wave-22 inherited |
| error-on-wrong | 1 | 1 | 1 | 0 | deterministic |

All 9 buckets identical across all 3 wave-25 replicates. `fail-or-review-on-wrong = 100%` preserved.

### 4.1 Which case recovered

**deg-beer-0001** recovered (`class_type` was null while brand + ABV + warning all read cleanly).

**deg-spirits-0003** did NOT recover. The brand comparator returned `fail` at confidence **0.14** (not the null-extraction sentinel of conf 0.0). The model emitted *some* string for brand_name with token-set ratio 1.00 (containing the declared "Vidalia" plus extra tokens) but a Levenshtein ratio of 0.14 due to length mismatch. The regression guard correctly held: a non-null-extraction fail coexists, so the null safety net doesn't fire.

Recovery of `deg-spirits-0003` needs a different intervention — a brand-comparator token-containment relaxation (when declared is a clean subset of extracted tokens). Wave-26 candidate.

## 5. Cumulative progress (waves 22 + 23 + 24 + 25)

| Bucket | Baseline (N=8 mean) | Wave-25 (N=3) | Δ |
|---|---:|---:|---:|
| **false-fail** | **11.9** | **3** | **−8.9 (compliant labels saved from wrongful rejection)** |
| review-on-correct | 41.3 | 51 | +9.7 (friction-shifted, safer) |
| **false-pass-on-correct** | **4.6** | **5** | **+0.4 (within noise)** |
| true-pass | 39.3 | 38 | −1.3 |
| true-reject | 164.3 | 168 | +3.7 (sharper rejection) |
| review-on-wrong | 4.8 | 1 | −3.8 |

Pass-rate-on-correct: 65.8% baseline → 65.1% (deterministic across 12 successive runs spanning waves 22–25). The federal reviewer sees the same verdict on the same image every time.

## 6. Conclusion

Wave-25 ships. Targeted intervention; predictable outcome; no acceptance violations.

- ✓ Pre-registered acceptance criterion met (fp-on-correct = 5)
- ✓ 1 of 2 predicted Cluster-C false-fails recovered
- ✓ Determinism preserved (all 9 buckets identical across N=3)
- ✓ Wrong-GT rejection preserved (fail-or-review-on-wrong = 100%)

## 7. Next intervention priorities

1. **Wave-26**: brand-comparator token-containment relaxation. Targets `deg-spirits-0003` and any future similar case where the extractor emits a longer string containing the declared brand. Risk-bounded by token-set ≥ 0.95 + minimum declared-length guard.
2. **Cluster A residuals (ai-label-0031, ai-label-0050)**: text-recovered (wave-23) but `size=review` still drives the verdict. Same root cause as the wave-21 size-channel problem.
3. **Synthetic B/S false-pass-on-correct (5 deterministic)**: same wave-21 size-channel problem from the other direction. Multi-signal voting may be the path.
4. **review-on-correct (51, up from 41.3 baseline)**: the biggest remaining UX lever. Mostly the bold-fallback-only-PASS path firing on the second-opinion's borderline-bold cases. Could be addressed by a sharper bold-detection in the validator OR by accepting the second-opinion's agreement more aggressively.

References:
- `docs/WAVE-22-FINDINGS.md` — second-opinion model swap baseline
- `docs/WAVE-23-FINDINGS.md` — Gov-Warning text case-fold
- `docs/WAVE-24-FINDINGS.md` — class generic-on-label acceptance
- `docs/BENCH-PROTOCOL.md` — N≥3 + 2σ rule
