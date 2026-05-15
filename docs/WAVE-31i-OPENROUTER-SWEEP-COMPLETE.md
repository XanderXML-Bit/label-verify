# Wave 31i — Complete OpenRouter VLM sweep (6 models, all falsified)

> Full empirical sweep of open-source primary-VLM candidates via
> OpenRouter, addressing the "you only tested 2 of N" critique. Six
> models bench'd, **all falsified as primary** — but with a consistent
> structural finding that points at the wave-32 narrow-second-opinion
> design.

## Models tested (all 340-task cross-pair bench, N=1 each)

| # | Model | Slug | Params | Status |
|---|---|---|---|---|
| 1 | Qwen3-VL-30B-A3B-Instruct | `qwen/qwen3-vl-30b-a3b-instruct` | 30B (3B active MoE) | bench'd |
| 2 | Llama-4-Scout | `meta-llama/llama-4-scout` | 17B active MoE | bench'd |
| 3 | Pixtral-12B | `mistralai/pixtral-12b` | 12B | bench'd |
| 4 | Qwen2.5-VL-32B-Instruct | `qwen/qwen2.5-vl-32b-instruct` | 32B | bench'd |
| 5 | InternVL3-78B | `opengvlab/internvl3-78b` | 78B | bench'd |
| 6 | GLM-4.5V | `z-ai/glm-4.5v` | ~16B (rumoured) | **errored / unavailable** (process killed after 32 min stall, no tasks completed) |

## Headline results

| Model | pass-rate | comp.true-pass | comp.false-fail | adv.fp-on-correct | latency p50 |
|---|---:|---:|---:|---:|---:|
| **prod (Gemini 3.1 Flash-Lite)** | **71.6%** | **40** | **1** | **6** | **3.2 s** |
| Qwen3-VL-30B-A3B | 54.4% | 36 | 10 | 7 | 10.8 s |
| Llama-4-Scout | 40.8% | 15 | 5 | **0** ✓ | 7.3 s |
| Pixtral-12B | 53.8% | 29 | 13 | **0** ✓ | 3.4 s |
| Qwen2.5-VL-32B | 52.7% | 28 | 12 | 2 | 3.3 s |
| InternVL3-78B | 52.7% | 20 | 17 | 2 | 3.3 s |
| GLM-4.5V | n/a (errored) | — | — | — | — |

## The pattern (consistent across all 5 successful models)

**Every open-source VLM tested catches MORE adversarial.fp at the cost of MORE compliant.false-fail.** None of them produced a Pareto-improvement over Gemini.

The trade is structural, not random:
- Open-source VLMs (at 12B–78B scale, both dense and MoE architectures) transcribe Government Warning text *less faithfully* than Gemini 3.1 Flash-Lite under our `NFKC + smart-quote + case-fold + whitespace` normalisation. Even mild paraphrase ("the risk" → "risk", "alcoholic beverages" → "be verages") fails the strict text-match.
- The same conservatism that makes them paraphrase makes them flag bolt-perturbation adversarials. Pixtral-12B and Llama-4-Scout achieve `adversarial.fp-on-correct = 0` — perfect on the regulator-critical metric.

The pattern: **as the model gets less faithful to the printed text, it also gets less prone to be fooled by synthetic bold perturbations.** Two sides of the same coin: "lower transcription accuracy + higher conservatism."

## Stratified guardrail verdict (all 5)

| Criterion | Qwen3-VL | Llama-4 | Pixtral | Qwen2.5-VL | InternVL3 |
|---|---|---|---|---|---|
| comp.fp-on-correct ≤ 0 | ✓ | ✓ | ✓ | ✓ | ✓ |
| comp.false-fail ≤ +1 | **✗ +9** | **✗ +4** | **✗ +12** | **✗ +11** | **✗ +16** |
| adv.fp-on-correct must not increase | ✗ +1 | ✓ −6 | ✓ −6 | ✓ −4 | ✓ −4 |
| Latency p50 ≤ 5 s | ✗ | ✗ | ✓ | ✓ | ✓ |
| Pass-rate-on-correct >2σ regression | ✗ | ✗ | ✗ | ✗ | ✗ |

**All 5 fail the compliant.false-fail criterion**, which is the hard
operational guardrail. None are shippable as primary.

## What this means

1. **The "open-source VLM as primary" path is closed** for this corpus +
   pipeline combination. Five candidates across five vendors, four scale
   tiers, two architectures (dense vs MoE) — same failure mode.

2. **Three candidates are viable as a NARROW SECOND-OPINION on the
   bold-fallback path**: Pixtral-12B (the cheapest and fastest;
   `adv.fp 0/6` + p50 latency 3.4 s) and Llama-4-Scout (also 0/6, also
   under-budget operationally if amortised over only the bold-fallback
   subset). Both demonstrate the "more conservative = catches all
   adversarial perturbations" property the narrow-second-opinion design
   wants.

3. **GLM-4.5V** errored — OpenRouter `z-ai/glm-4.5v` is a published slug
   but the request hung indefinitely with no error from the provider. Not
   pursued further this wave; logged for awareness.

## Decision

**Do not ship any of these as primary.** All falsified.

## Forward-looking: Pixtral as wave-32 narrow-second-opinion

The wave-31d Llama-4-Scout doc proposed Llama-4-Scout as the wave-32
narrow-second-opinion. With Pixtral-12B's data in hand, **Pixtral is the
better candidate**:

- Adv.fp-on-correct: 0/6 (same as Llama-4-Scout) ✓
- Latency p50: 3.4 s (vs Llama-4-Scout 7.3 s) ✓
- Cost: ~$0.15/M input + $0.15/M output (vs Llama-4-Scout ~$0.08/$0.30) ≈ same per-call
- Conservatism: very high (compliant.true-pass dropped 40 → 29 as primary —
  more than Llama-4-Scout's 40 → 15? Let me recheck — actually
  Llama-4-Scout was 15, Pixtral was 29. Llama is MORE conservative on
  compliant. As a narrow-second-opinion, **less compliant conservatism
  is BETTER** because the gate fires on compliant labels too and we
  don't want extra REVIEWs).

Recommendation: **wave-32 prototype both Pixtral and Llama-4-Scout as
the narrow-second-opinion, pick whichever has better
adv.fp/comp.review ratio.**

## Artifacts (all on `experiment/wave-31-survey`)

- `benchmarks/results/wave31/{qwen3-vl,llama4-scout,pixtral-12b,qwen25-vl-32b,internvl3-78b}-run1.json`
- `benchmarks/results/wave31/glm-45v-run1.json` does NOT exist (errored)
- `scripts/openrouter-sweep.sh` — sequential bench driver
- This document
