# Wave 31c — Qwen3-VL-30B-A3B as primary extractor (FALSIFIED)

> Tested whether swapping the primary VLM from Gemini 3.1 Flash-Lite to
> Qwen3-VL-30B-A3B-Instruct (Apache 2.0, via OpenRouter at
> `qwen/qwen3-vl-30b-a3b-instruct`) would improve the headline
> pass-rate-on-correct or attack the 6 adversarial fp-on-correct cases.
> **Hypothesis falsified empirically and catastrophically.**

## Pre-registered hypothesis

> A larger, more recent open-source VLM (Qwen3-VL is the late-2025
> generation, with strong document-understanding benchmarks) might
> either (a) be more conservative on synthetic adversarials and bring
> `adversarial.fp-on-correct` from 6 → ≤4, OR (b) match production on
> compliant labels while costing less. Both would unlock a path away
> from the closed-Gemini dependency. Worth testing because Qwen3-VL's
> OpenRouter availability lets us run it at production-ish quality
> without self-hosting.

## What we built

- Extended `buildDefaultExtractor()` in `src/lib/verify.ts` to honor
  `MODEL_PRIMARY_PROVIDER=openrouter` + `MODEL_PRIMARY_SLUG` env vars.
  The picker re-instantiates an `OpenRouterExtractor` (existing module,
  Wave-15) keyed to the slug.
- Cache slot keyed by `(provider, overrideVersion, orSlug)` so
  successive calls with the same env reuse the extractor instance.
- Added `MODEL_PRIMARY_OR_PRICE_IN/OUT` env vars (defaulting to
  $1/$3 per 1M) so the extractor's required `pricing` field stays
  honest in cost accounting.
- `scripts/smoke-openrouter.ts` validated wire-up: vision 4.6s,
  verdict=pass on syn-beer-0002.

## Bench result (N=1, cross-pair, 170 images × 2 = 340 tasks)

| Metric | Wave 28b (Gemini-3.1-Flash-Lite, prod main) | Wave 31c (Qwen3-VL-30B-A3B) | Δ |
|---|---:|---:|---:|
| pass-rate-on-correct (headline) | 71.6% | **54.4%** | **−17.2 pp** ⚠️ |
| compliant.true-pass | 40 | **36** | −4 |
| compliant.true-reject | 51 | **52** | +1 |
| compliant.review-on-correct | 31 | **7** | −24 |
| compliant.false-fail | 1 | **10** | **+9** ⚠️⚠️ |
| **compliant.fp-on-correct** | 0 | 0 | 0 ✓ |
| **adversarial.fp-on-correct** | 6 | **7** | **+1** ⚠️ |
| adversarial.true-fail | 49 | 49 | 0 |
| adversarial.true-reject | 78 | 78 | 0 |
| adversarial.false-fail | 5 | 7 | +2 |
| quality.true-pass | 8 | 4 | −4 |
| quality.false-fail | 1 | 4 | +3 |
| total p50 latency | 3.2 s | **10.8 s** | +7.6 s (3.4× slower) |
| total p95 latency | 12.5 s | 23.2 s | +10.7 s |
| errors | 2 | 2 | 0 |

## Why the hypothesis failed

Three signals point to the same root cause:

1. **+9 compliant.false-fail in one swap.** Qwen3-VL's gov-warning text
   transcription is *less* faithful to the printed text than Gemini's.
   On a corpus where the regulator-strict text-match subscore demands
   byte-for-byte equality (after Unicode + smart-quote + case folding),
   even mild paraphrase or letter-skip drops the verdict from PASS to
   FAIL. The compliant.false-fail rate jumped 1 → 10.

2. **adversarial.fp-on-correct went UP (+1, not down).** The "bigger
   model = more conservative" assumption was wrong. Qwen3-VL passed one
   *additional* synthetic adversarial that Gemini correctly flags. The
   benefit (catching synthetic perturbations) didn't materialize.

3. **3.4× latency.** OpenRouter routes through one of several hosting
   providers, and Qwen3-VL's 30B parameter count drives per-image cost
   to ~6s vision time (Gemini 3.1 Flash-Lite: ~1.8s). The 5 s
   operational budget is busted by a factor of 2.

## Stratified guardrail verdict

| Criterion | Verdict |
|---|---|
| compliant.fp-on-correct must not increase | ✓ (held at 0) |
| compliant.false-fail ≤ +1 | ✗ (**+9** — well outside the +1 noise band) |
| adversarial.fp-on-correct must not increase | ✗ (+1) |
| Latency p50 ≤ 5 s (operational soft) | ✗ (10.8 s) |
| Pass-rate-on-correct must not regress >2σ | ✗ (−17.2 pp; far outside) |

Three hard criteria fail. No ambiguity.

## Decision

**Do not ship.** Branch artifacts remain on `experiment/wave-31-survey`.
Production stays on Gemini 3.1 Flash-Lite primary.

## What this means for the broader retrospective

The retrospective's "open-source VLM" suggestion is technically
falsifiable; one such candidate is now falsified empirically. The
result generalizes the lesson from PaddleOCR (wave-31a): on a
regulator-strict text-match pipeline, the marginal model needs to be
*more accurate*, not *cheaper-or-more-permissive*. Most open-source
VLMs at this size/cost point are tuned for chat-style document QA,
where mild paraphrase is acceptable. Our subscore is allergic to that
exact failure mode.

## Open question (not pursued)

Would a *larger* open-source VLM (Qwen2.5-VL-72B, InternVL3-78B, or
Llama-4-Maverick) close the gap? Unclear. The pricing/latency trade
gets worse, and the failure mode (transcription paraphrase) might
persist even at 78B. The Llama-4-Scout bench (smaller MoE, ~17B
active) is in flight on the same branch — its result will tell us
whether the failure-mode is parameter-count-bound or architecture-bound.

## Artifacts (kept on branch only)

- `src/lib/verify.ts` — `buildDefaultExtractor` extended with
  OpenRouter branch
- `scripts/smoke-openrouter.ts` — smoke test
- `benchmarks/results/wave31/qwen3-vl-run1.json` — full per-image results
- This document

The `MODEL_PRIMARY_PROVIDER` env-gated picker stays under feature-flag
and is unreachable when the env is unset.
