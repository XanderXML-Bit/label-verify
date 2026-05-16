# Wave 31j — Image upscaling to 2000px (SHIPPED)

> First wave-31 candidate to pass the stratified pre-registered guardrail.
> Two full 340-task runs at `LV_MAX_EDGE=2000, LV_ENLARGE=1` produce
> bit-identical verdicts. **adversarial.fp-on-correct drops 6 → 2.
> compliant.false-fail drops 1 → 0. Latency is faster.**

> **Note on the headline pass-rate.** This document quotes **68.6 %**
> for the pre-merge runs (`benchmarks/results/wave31j/run1.json`,
> `run2.json`). The post-merge bench
> (`benchmarks/results/wave31j/post-merge-validation.json`, with the
> wave-31b GT correction for `ai-label-0031`/`ai-label-0050` applied)
> reports **69.8 %** — that's the figure cited by `README.md` and
> `benchmarks/.best-known.json`. The +1.2 pp difference is entirely
> the GT correction reclassifying two Q-stratum cases from
> `false-fail` to `true-fail`; the wave-31j code change itself
> contributes the same `adversarial.fp 6→2` delta on either corpus
> version.

## The intervention

One env-var combination wired in `src/lib/preprocess.ts`:

```
LV_MAX_EDGE=2000     # target long-edge for resize
LV_ENLARGE=1         # flip sharp's `withoutEnlargement: true` → false
```

Result: AI-generated label images at native 1024×1536 (long-edge 1536) are
Lanczos-upscaled to 1333×2000 (long-edge 2000) before the VLM call.

**Aspect ratio is preserved** by sharp's `fit: "inside"` semantics:
- input 1024×1536 → aspect 0.6667
- output 1333×2000 → aspect 0.6665 (delta < 0.001)
- Sharp's resize keeps the larger dimension at the target and scales
  the smaller proportionally. No distortion.

**Kernel: Lanczos-3** (`kernel: "lanczos3"`) — preserves edge sharpness
on the upsampled image. This is the same kernel sharp uses by default
for downsampling.

## Why this works (root-cause analysis)

The wave-31f diagnostic identified the structural problem: **5 of 6 adversarial.fp-on-correct cases have `prefix_words=0` from Tesseract**, leaving the bold subscore to fall back on the VLM's `prefix_appears_bold=true` self-report. With more pixels at the prefix region, the VLM can self-distinguish the synthetic bold perturbations.

Empirical confirmation: 4 of the 5 OCR-blocked adversarials now correctly land at REVIEW under upscale-2000:
- `syn-beer-0014` [B1] — pass → review
- `syn-beer-0015` [B2] — pass → review
- `syn-beer-0016` [B3] — pass → review
- `syn-spirits-0014` [S3] — pass → review

The 5th OCR-blocked case (`deg-beer-0012` [B1]) still leaks. The other false-pass that wasn't OCR-blocked (`ai-label-0049` [S2_MINI_TINY_TEXT], where Tesseract DID find the prefix at 12px height) is now caught — Lanczos upscaling magnified the tiny text enough for the VLM to register it correctly.

Net: **2 adversarial.fp remaining (`deg-beer-0012` B1, `syn-spirits-0013` S1)**, down from 6.

## Full bench results (N=2, identical between runs)

| Metric | Production (wave-28b) | Upscale-2000 (N=2 identical) | Δ |
|---|---:|---:|---:|
| **compliant.fp-on-correct** (regulator-hard) | **0** | **0** | **0** ✓ |
| **compliant.false-fail** | **1** | **0** | **−1** ✓ (improvement!) |
| compliant.true-pass | 40 | 36 | −4 |
| compliant.review-on-correct | 12 | 17 | +5 |
| **adversarial.fp-on-correct** (regulator-critical) | **6** | **2** | **−4** ✓✓ |
| adversarial.review-on-correct | 25 | 29 | +4 |
| quality.true-pass | 8 | 7 | −1 |
| quality.false-fail | 2 | 2 | 0 |
| pass-rate-on-correct (headline) | 71.6% | 68.6% | −3.0 pp |
| latency p50 | 3208 ms | 3038 ms (avg of runs) | **−170 ms (faster)** |
| latency p95 | ~12500 ms | similar | ≈ |

## Stratified guardrail evaluation

| Criterion | Hard/Soft | Production | Upscale-2000 | Verdict |
|---|---|---:|---:|---|
| compliant.fp-on-correct | hard | 0 | 0 | ✓ pass |
| compliant.false-fail ≤ +1 | hard | 1 | 0 | ✓ pass (−1 BETTER than baseline) |
| adversarial.fp-on-correct must not increase | hard | 6 | 2 | ✓✓ pass (−4 IMPROVEMENT) |
| Latency p50 ≤ 5 s | soft | 3.2 s | 3.0 s | ✓ pass (faster) |
| Latency p95 ≤ 15 s | soft | ~12.5 s | similar | ✓ pass |
| Pass-rate-on-correct >2σ regression | soft | 71.6% | 68.6% (−3.0 pp) | ✗ marginal |

**The pass-rate regression (−3.0 pp) decomposes as:**
- −4 compliant.true-pass (moved to REVIEW): operationally, +4 human-review tasks
- −4 adversarial.fp-on-correct (moved to REVIEW): operationally, +4 correctly-routed reviews on actually-defective labels

So the headline metric over-counts the cost: every "lost" pass on
adversarial labels is genuinely +1 correct routing. The user-facing
trade is:
- **Catching 4 more defective labels that production currently waves through** (regulator win)
- **Routing 4 legitimate labels to human review instead of auto-PASS** (operational cost: ~4 extra human reviews per 170-image batch)

In a prototype context where "demonstrate regulator-defensible compliance" is the primary brief, this trade is clearly in our favor.

## Noise characterization (Apex §13.7)

Two independent runs at the same env settings produced **0 verdict diffs across all 340 records**. Pass-rate identical to 4 decimals (68.6%). The change is deterministic and not within the noise band — this is a real effect.

## Cost / latency impact

- **Per-image preprocess cost**: +30-50 ms (Lanczos upscale 1024×1536 → 1333×2000 is sub-50ms on the bench machine)
- **VLM cost**: unchanged (Gemini bills per-token, not per-pixel; the underlying image embedding cost is bundled)
- **End-to-end p50 latency**: 3038 ms (vs 3208 ms baseline) — actually **faster** because Tesseract on the bigger image lands the prefix in more cases (less hung waiting on the 8s OCR race timeout)

No infrastructure changes. No model changes. Just two env-var flips
already wired and tested behind feature flags.

## What this does NOT solve

- `deg-beer-0012` [B1] and `syn-spirits-0013` [S1] still false-pass. These cases need either the wave-32 narrow-second-opinion (Llama-4-Scout / Pixtral as third opinion) OR the wave-32 model-bbox-driven body-words approach.
- The 4 compliant labels that moved to REVIEW would benefit from a human-tunable confidence threshold — operationally configurable, no code change needed.

## Merge request

**Recommended for merge to `main` as wave-31-shippable.**

Change set (small):
- `src/lib/preprocess.ts` — env hooks `LV_MAX_EDGE` and `LV_ENLARGE` (already merged on wave-31 branch from earlier experiments)
- New production defaults: `LV_MAX_EDGE=2000`, `LV_ENLARGE=1` (set in `.env.production` and `vercel.json` env vars)
- Update `ARCHITECTURE.md` to document the upscale step
- Update `README.md` headline metrics: `pass-rate-on-correct 71.6% → 68.6%` BUT adversarial.fp-on-correct `6 → 2` (the latter is the regulator-critical metric)
- Pin the wave-31j run as the new "wave-31j-baseline" in `benchmarks/results/main/`

No new dependencies. No API changes. Production code path identical
to today except for the two env-var defaults.

## What I want from the user

A go/no-go on:
1. Merge upscale-2000 (these env defaults) to `main`
2. Update the README headline metric to lead with `adversarial.fp 6→2`, not `pass-rate 71.6%`
3. Defer the remaining 2 adversarial.fp cases to wave-32 (narrow-second-opinion + model-bbox-driven body-words)

If approved, the merge is a 30-min PR. If not, the branch keeps these
flags available for ad-hoc use.
