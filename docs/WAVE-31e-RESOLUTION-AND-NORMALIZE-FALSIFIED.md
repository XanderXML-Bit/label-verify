# Wave 31e — Resolution sweep + normalize-order experiments (FALSIFIED)

> Two pre-pipeline tunables that came out of the §12.3 sub-agent review:
> (a) `LV_MAX_EDGE` sweep over 800/1200/1600/2000/2400 long-edge px,
> (b) `LV_NORMALIZE_ORDER=before-resize` to test the sub-agent's §1.2
> hypothesis (normalize-after-resize crushes midtones). **Both falsified
> on a 23-image stratified sample** — production defaults are at the
> flat region of both surfaces.

## Sample design (shared across rezsweep / normalize-order / otsu-bodyrel benches)

23 images × 2 conditions (correct GT + perturbed wrong GT) = 46 tasks per variant. Stems chosen to maximise signal:

- All 6 adversarial.fp-on-correct cases (`ai-label-0049`, `deg-beer-0012`, `syn-beer-0014/15/16`, `syn-spirits-0014`)
- 8 quality cases including the GT-noise pair (`ai-label-0031`, `ai-label-0050`)
- 8 compliant true-pass exemplars
- 1 deg-spirits ambiguous case

Rationale: small enough to run 4× in 5 min (vs full 340-task bench at ~15 min each), but stratified to catch regressions in all four buckets the production guardrail protects.

## Resolution sweep result

| Resolution (long edge px) | correct.pass | correct.fail | correct.review | wrong.fail | wrong.pass | vision p50 |
|---:|---:|---:|---:|---:|---:|---:|
| 800 | 12 | 1 | 10 | 23 | 0 | 2.4 s |
| 1200 | 19 | 2 | 2 | 23 | 0 | 2.4 s |
| **1600 (default)** | **20** | **2** | **1** | **23** | **0** | **2.4 s** |
| 2000 | 20 | 2 | 1 | 23 | 0 | 2.0 s |
| 2400 | 20 | 2 | 1 | 23 | 0 | 2.2 s |

Findings:
- **800 long-edge is materially worse**: 8 compliant labels regress from PASS to REVIEW.
- **1200/1600/2000/2400 are identical on the sample.** The verdict surface is flat above 1200.
- **wrong.pass = 0 at every resolution including the 6 adversarial.fp-on-correct cases.**
  Note: this *contradicts* the wave-28b full-bench result (6 adversarial fp).
  Explanation: this sample tests the cross-pair perturbed GT (`condition=wrong`),
  which always uses a deliberately-different declared object — perturbed GT never
  matches a real label. The 6 wave-28b false-passes happen on the *correct* GT
  for synthetic adversarials (the bench labels these as "compliant by GT" but
  actually-defective). Those are captured in `correct.pass = 20` here. Of those
  20: ~6 are adversarial labels we know production passes (the wave-28b
  fp-on-correct cases), the rest are legitimate compliant PASS.
- **2000 px has slightly better latency (2.0 vs 2.4 s p50)** but no verdict
  benefit. Not worth the resize cost.

**Decision: keep default `LV_MAX_EDGE=1600`.** A 2000-px default *might*
yield 0.4 s latency improvement, but on N=23 sample and given the
identical verdict distribution, the change is not actionable.

## Normalize-order result

| Variant | correct.pass | correct.fail | correct.review | wrong.fail | wrong.pass |
|---|---:|---:|---:|---:|---:|
| `after-resize` (default) | 20 | 2 | 1 | 23 | 0 |
| `before-resize` | 20 | 2 | 1 | 23 | 0 |

**Per-stem verdict diffs: zero.** Every stem produces the same verdict
under both orderings on this sample.

Sub-agent §1.2 hypothesis falsified at this sample. The labels in our
corpus apparently don't exercise the "busy-background midtone-crush"
failure mode the sub-agent predicted. Possible explanations:
- Our 170-image corpus is dominated by AI-generated synthetic labels
  and real-photo bottles on plain backgrounds. The corpus may
  systematically under-represent the labels (foiled, low-light,
  dark-background photo-realistic) where normalize-order matters.
- `sharp.normalize()` is a global histogram stretch (rescale min/max
  to [0,255]). On already-well-exposed inputs (the common case for
  modern phone cameras) it's a near-no-op regardless of order.

**Decision: keep default `LV_NORMALIZE_ORDER=after-resize`.**

## Artifacts

- `benchmarks/results/wave31/rezsweep-run1.json`
- `benchmarks/results/wave31/normalize-order-run1.json`
- `scripts/rezsweep.ts`
- `scripts/normalize-order-bench.ts`
- This document
