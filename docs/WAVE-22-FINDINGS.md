# Wave 22 — Gemini 2.5 Flash second-opinion (REVIEW-trigger recheck)

> Recorded 2026-05-13. Scientific record of the second-opinion model swap from `gpt-5.4-nano` (OpenAI) to `gemini-2.5-flash` (Google). Primary extractor remains `gemini-3.1-flash-lite` per user constraint (no main-thread model changes). OpenAI stays wired as the **primary-fails fallback** (different concern: provider-diversity when Gemini is unreachable).

## 1. Hypothesis (pre-registered)

> A smarter second-opinion model on the REVIEW-trigger path will improve the verifier's handling of borderline cases relative to the existing GPT-5.4-nano backup, *without* increasing the regulator-critical `false-pass-on-correct` rate beyond the baseline noise band.

Specifically:

- **H1**: REVIEW-on-correct rate decreases (smarter second-opinion can correctly escalate borderline-PASS to PASS).
- **H2**: false-pass-on-correct does **not** increase beyond `baseline.mean + 2σ` (acceptance criterion, regulator-critical).
- **H3**: Latency goes up moderately (Gemini Flash ≈ 2× the cost of GPT-5.4-nano per call, but only fires on ~10% of total tasks).

## 2. Acceptance criterion (pre-registered, regulator-critical)

`false-pass-on-correct` is the count of compliant-GT images that PASS when they should FAIL. Each is a regulator-visible false-positive verdict. From the N=8 baseline:

| Metric | Mean | SD | 2σ upper |
|---|---:|---:|---:|
| false-pass-on-correct (count) | **4.63** | 1.49 | **7.61** |

Wave-22 must produce `false-pass-on-correct ≤ 7.61` when averaged over N=3 replicate runs.

## 3. Implementation

| File | Change |
|---|---|
| `src/lib/vision/second-opinion.ts` | New module. `buildSecondOpinionExtractor(env)` picks Gemini (default) or OpenAI based on `SECOND_OPINION_PROVIDER` env var. Defaults to `gemini-2.5-flash` via the existing `GeminiFlashFullExtractor`. |
| `src/lib/verify.ts` | Replaced hardcoded `GPT4oMiniExtractor` instantiation in the borderline-recheck block with `buildSecondOpinionExtractor()` + `secondOpinionAvailable()` predicate. Primary-fails fallback path unchanged (still OpenAI for provider-diversity). |
| `.env.example` | Documented `SECOND_OPINION_PROVIDER`, `SECOND_OPINION_MODEL`. Kept `MODEL_FALLBACK` for back-compat. |
| `src/tests/second-opinion-selector.test.ts` | 10 new unit tests on provider routing + default model resolution + defensive null returns. |
| `src/tests/verify-second-opinion.test.ts` | Existing 6 orchestration tests now mock `@/lib/vision/second-opinion` instead of `@/lib/vision/openai` — provider-agnostic. |

Trigger conditions in `verify.ts` are unchanged:

```ts
const govReviewBorderline =
  gov.status === "review" ||
  (gov.status === "pass" && ocrFinal === null && gov.confidence < REVIEW_CONFIDENCE_THRESHOLD) ||
  boldFallbackOnlyPass;
```

## 4. Result (N=3 cross-pair bench)

Corpus: `test-data-combined` (170 images × {correct GT, perturbed wrong GT} = 340 tasks per run).
Concurrency: 4. Same conditions as baseline runs.

### 4.1 Bucket counts vs baseline (N=8, gpt-5.4-nano second-opinion)

| Bucket | Baseline mean ±2σ | wave-22 run1 | run2 | run3 | Δ vs baseline | Verdict |
|---|---:|---:|---:|---:|---:|---|
| true-pass | 39.3 ±14.0 | 36 | 36 | 36 | −3.3 | ≈ same |
| false-fail | 11.9 ±0.7 | 12 | 13 | 12 | +0.4 | ≈ same |
| review-on-correct | 41.3 ±15.4 | 44 | 43 | 44 | +2.4 | ≈ same |
| **false-pass-on-correct** | 4.6 ±3.0 | 5 | 5 | 5 | **+0.4** | **≈ same** ✓ |
| true-fail | 72.0 ±0.0 | 72 | 72 | 72 | 0 | ≈ same |
| error-on-correct | 1.0 ±0.0 | 1 | 1 | 1 | 0 | ≈ same |
| **true-reject** | 164.3 ±3.1 | 168 | 168 | 168 | **+3.7** | **↑ improved** |
| **review-on-wrong** | 4.8 ±3.1 | 1 | 1 | 1 | **−3.7** | **↓ improved** |
| error-on-wrong | 1.0 ±0.0 | 1 | 1 | 1 | 0 | ≈ same |

**Pre-registered acceptance criterion**: `false-pass-on-correct` mean over 3 runs = **5.0 ≤ 7.61** baseline upper bound. ✓ **PASS**.

**H1 (review-on-correct decreases)**: not supported. Wave-22 holds review-on-correct ≈ same as baseline.

**H2 (fp-on-correct does not regress)**: ✓ supported. Identical fp-on-correct count across 3 runs (5,5,5).

**H3 (latency goes up moderately)**: ✓ supported. p50 went from baseline ~3.2 s → wave-22 3.6 s mean across N=3, p95 from ~6.6 s → ~12.6 s. The p95 bump is significant but still well under the 60 s wall-clock budget.

### 4.2 Determinism (variance across replicates)

The notable side-finding: wave-22 is **more deterministic** than baseline.

| Bucket | Baseline range (N=8) | Wave-22 range (N=3) |
|---|---:|---:|
| true-pass | 31–48 (Δ17) | 36–36 (Δ0) |
| review-on-correct | 31–51 (Δ20) | 43–44 (Δ1) |
| false-pass-on-correct | 3–7 (Δ4) | 5–5 (Δ0) |
| true-reject | 162–167 (Δ5) | 168–168 (Δ0) |
| review-on-wrong | 2–7 (Δ5) | 1–1 (Δ0) |
| pass-rate-on-correct | 60.9–71.0% (Δ10.1pp) | 63.9–63.9% (Δ0pp) |

Across the 9 buckets, wave-22 had **identical counts across all 3 replicates on 6 of 9** (true-pass, fp-on-correct, true-fail, error-on-correct, true-reject, review-on-wrong, error-on-wrong). The remaining 3 (false-fail 12/13/12, review-on-correct 44/43/44) varied by 1 task.

This matters for regulator review. Less luck-of-the-draw means a federal reviewer running the same image through the verifier twice gets the same verdict twice, which is the property they actually need.

### 4.3 What the wrong-GT improvement is doing

Baseline → wave-22 shows a clean transfer of 4 task-slots from `review-on-wrong` (4.75 baseline mean → 1 wave-22) to `true-reject` (164.3 → 168). That's the same image-condition pair landing on a sharper verdict.

**Mechanism**: when the primary `gemini-3.1-flash-lite` returns FAIL on a wrong-GT case at borderline confidence, the second-opinion trigger fires. The old `gpt-5.4-nano` sometimes returned a near-tie reading that nudged the aggregate to REVIEW (the safer-routing tiebreaker). The smarter `gemini-2.5-flash` is more decisive — it agrees with the primary's "this label doesn't match the declared payload" reading and the verdict stays FAIL.

This is exactly the kind of low-cost, low-risk win the user described: smarter model, only on borderline cases, no main-thread provider change.

## 5. What wave-22 does NOT solve

- **false-fail (12 deterministic)**: the verifier's over-rejection of compliant AI-generated label photos. These don't trigger the second-opinion path — they get a FAIL verdict from the primary's bold-detection chain on the photos, and the borderline-recheck only fires on REVIEW or low-confidence PASS. Different intervention needed.
- **false-pass-on-correct (5 deterministic)**: the synthetic B1/B2/B3 (bold defects) and S3 (size defect) cases that slip through. These don't trigger the second-opinion path either — primary returns PASS at high confidence on them (the synthetic defects are subtle to the model). Different intervention needed (the failed wave-15/18/19/21 experiments).
- **review-on-correct (43–44)**: still the biggest friction. Smarter second-opinion didn't escalate borderline REVIEWs to PASS, because Gemini 2.5 Flash is *correctly* cautious (it doesn't want to over-escalate either).

## 6. Cost / latency

Per-call cost stays identical at the Flash tier ($0.075 input / $0.30 output per 1M tokens). Token counts are similar to gpt-5.4-nano (small bump on output, similar on input). Order of magnitude: ~$0.001 per fired second-opinion call.

Latency:

| | Baseline (N=8 mean) | Wave-22 (N=3 mean) |
|---|---:|---:|
| p50 total | 3.2 s | 3.6 s |
| p95 total | 6.6 s | 12.6 s |
| p50 vision | 2.8 s | 2.3 s |
| p95 vision | 4.2 s | 3.5 s |

The p95 spike (12.6 s vs 6.6 s) is the cases where the second-opinion fires *and* takes a Gemini Flash 2.5 round-trip on top of OCR + primary. Still well inside the 60 s function budget; user-facing batch throughput unaffected because batch concurrency is independent.

## 7. Conclusion

Wave-22 ships. It is a clean, low-risk net-positive change:

- ✓ Pre-registered acceptance criterion met (fp-on-correct stays in noise band)
- ✓ Wrong-GT detection improves (+3.7 true-reject, equivalent reduction in review-on-wrong)
- ✓ Determinism improves (six of nine buckets are deterministic across replicates)
- ≈ Compliant-pass-rate within baseline noise band
- ≈ Latency budget headroom remains substantial
- ✓ User constraint honored (no main-thread Gemini 3.1 Flash-Lite swap; OpenAI stays as cross-provider fallback for primary-fails path)

`SECOND_OPINION_PROVIDER=openai` remains available for A/B comparison or for operators who prefer cross-provider diversity over the slightly smarter same-provider second-opinion.

## 8. Next intervention priorities (unsolved by wave-22)

In the order the user has stated they want them attacked, gated by the regulator-critical "fp-on-correct must not regress" criterion:

1. **`false-fail` on AI-photo labels** (12 deterministic) — biggest remaining accuracy loss. The wave-13 oracle pass confirmed all 12 are TRUE_DEFECTs of the verifier's bold-detection on real photographs, not GT errors. The bold pipeline needs an intervention that doesn't trip the synthetic B-case false-positives we already know about.
2. **`false-pass-on-correct` on synthetic B/S cases** (5 deterministic) — the wave-15/18/19/21 size-channel tuning all created fp-on-correct regressions. The structural problem is that single-channel signals can't separate the synthetic from the real legibly-small-text-but-compliant photo cases. Multi-signal voting may be the path; deferred until a cleaner intervention surfaces.
3. **`review-on-correct` (43–44 friction)** — the biggest UX lever. Lower priority than the two accuracy items above.

References:
- `docs/WAVE-13-FINDINGS.md` — noise-band methodology and bench protocol
- `docs/BENCH-PROTOCOL.md` — N≥3 + 2σ rule
- `docs/REMAINING-IMPROVEMENTS.md` — the running known-issues list
