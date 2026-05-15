# Wave 31d — Llama-4-Scout as primary extractor (FALSIFIED)

> Third primary-VLM-swap test (after PaddleOCR-31a, Qwen3-VL-31c).
> Llama-4-Scout (Meta, ~17B-active MoE, Apache 2.0, via OpenRouter at
> `meta-llama/llama-4-scout`). **Hypothesis falsified — but with one
> surprising upside that points at a future "narrow second-opinion"
> investigation.**

## Pre-registered hypothesis

> A MoE-architecture VLM with sparse activation (only ~17B params
> active per forward pass) might combine Qwen3-VL-class quality with
> better latency, and break the wave-31c "open-source VLMs transcribe
> too loosely" pattern. Llama-4 was Meta's first major multimodal
> release with strong document-reading benchmarks.

## Bench result (N=1, cross-pair, 170 images × 2 = 340 tasks)

| Metric | Wave 28b (Gemini, prod main) | Wave 31c (Qwen3-VL) | Wave 31d (Llama-4-Scout) | Δ vs prod |
|---|---:|---:|---:|---:|
| pass-rate-on-correct | 71.6% | 54.4% | **40.8%** | **−30.8 pp** ⚠️⚠️ |
| compliant.true-pass | 40 | 36 | **15** | −25 |
| compliant.true-reject | 51 | 52 | 52 | +1 |
| compliant.review-on-correct | 31 | 7 | **33** | +2 |
| compliant.false-fail | 1 | 10 | **5** | +4 |
| **compliant.fp-on-correct** | 0 | 0 | **0** | 0 ✓ |
| **adversarial.fp-on-correct** | 6 | 7 | **0** | **−6** ✓✓ |
| adversarial.true-fail | 49 | 49 | 49 | 0 |
| adversarial.true-reject | 78 | 78 | 79 | +1 |
| adversarial.review-on-correct | ~25 | 38 | **51** | +26 |
| quality.true-pass | 8 | 4 | 5 | −3 |
| quality.false-fail | 1 | 4 | 3 | +2 |
| total p50 latency | 3.2 s | 10.8 s | 7.3 s | +4.1 s |
| total p95 latency | 12.5 s | 23.2 s | 16.9 s | +4.4 s |
| errors | 2 | 2 | 2 | 0 |

## The surprising part

**adversarial.fp-on-correct = 0 (vs production's 6).** Llama-4-Scout
catches all 6 synthetic adversarial bold/caps/size defects that
production currently waves through. This is the headline metric the
project actually exists to protect (a false-PASS on a non-compliant
adversarial label is the regulator-critical failure mode).

The reason it isn't shippable as primary: Llama-4-Scout is
*indiscriminately conservative*. On compliant labels it pulls
`compliant.true-pass` from 40 → 15 and dumps 33 of them into
`compliant.review-on-correct` (vs production's 31). The compliant
labels aren't being failed (no false-PASS regression) — they're being
sent to human review. Operationally that's a 60% drop in throughput
on legitimate submissions.

The 6 adversarial-fp wins are real. The 25 compliant-pass losses are
real too. Net: production stays where it is.

## Why the hypothesis failed (with caveat)

1. **Pass-rate failure is structural, not architectural.** Llama-4-Scout
   reports `prefix_appears_bold=null` or `prefix_appears_bold=false` on
   ~60% of legitimately bold prefixes (read from the per-record traces).
   The classical-CV bold pipeline then can't restore the verdict to PASS
   because the model's vote is too conservative. Architecturally the
   model "sees" thin strokes everywhere — likely a calibration mismatch
   with the prompt's "bold" definition.

2. **3.4× p50 latency.** Same OpenRouter-routing penalty as Qwen3-VL.
   p50 7.3 s — outside the 5 s soft operational budget.

3. **+4 compliant.false-fail.** Same transcription-paraphrase failure
   mode as Qwen3-VL (though milder, +4 instead of +9).

## Stratified guardrail verdict

| Criterion | Verdict |
|---|---|
| compliant.fp-on-correct must not increase | ✓ (held at 0) |
| compliant.false-fail ≤ +1 | ✗ (+4) |
| **adversarial.fp-on-correct must not increase** | **✓✓ — went −6, the only candidate this wave to genuinely win this metric** |
| Latency p50 ≤ 5 s (operational soft) | ✗ (7.3 s) |
| Pass-rate-on-correct must not regress >2σ | ✗ (−30.8 pp) |

Three hard failures, but with one big counterweight.

## Decision

**Do not ship as primary.** The pass-rate regression is intolerable.
However — **this is the first wave-31 candidate with a real, demonstrable
adversarial-fp-on-correct win**. That's worth following up on, narrowly,
in a *separate* future wave.

## Future follow-up (NOT in scope for wave-31)

Hypothesis to test in a separate wave (call it Wave-32):
> **Narrow second-opinion via Llama-4-Scout, gated on the
> bold-fallback path only.**

Today's flow:
1. Gemini primary returns `prefix_appears_bold=true` AND OCR-stroke-width-ratio is ambiguous
2. Gemini 2.5 Flash second-opinion confirms `bold=true`
3. Verdict: PASS

The 6 adversarial fp-on-correct cases all flow through this path —
both Gemini calls (primary + second-opinion) collude on bold=true.
The synthetic perturbations are subtle enough that both Gemini
variants miss them.

Proposed Wave-32 architecture: when (1) and (2) both return `bold=true`,
add a *third* opinion (Llama-4-Scout) specifically on the bold subscore.
If Llama-4-Scout disagrees (says bold=false), flip the verdict to REVIEW
rather than PASS. This would:

- Hit all 6 adversarial fp-on-correct cases (Llama-4-Scout returns
  bold=false on them).
- Affect very few compliant labels (the gate is narrow — only fires
  when *both* Gemini calls say bold=true AND OCR is ambiguous, which is
  a small subset).
- Add 1 OpenRouter call per gated case (~6s, only when triggered) —
  amortized latency penalty per *image* would be small.
- Preserve production's 40 compliant.true-pass count (Llama-4-Scout
  isn't asked about any field other than bold; the primary extraction
  is unchanged).

Whether this works depends on the actual overlap between Llama-4-Scout's
"bold=false on adversarials" subset and its "bold=false on
compliants" subset. If it's discriminating *within* the bold-fallback
path, this works; if it just says bold=false on everything, it
degenerates into the catastrophic compliant.review-on-correct seen here.

That distinction requires per-image stratified analysis — beyond the
wave-31 scope, but worth queuing.

## Artifacts (kept on branch only)

- `benchmarks/results/wave31/llama4-scout-run1.json` — full per-image results
- This document
