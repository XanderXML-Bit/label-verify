# Wave 31k — Per-image resolution sensitivity (the "is 2000 always best?" investigation)

> User question (post-wave-31j merge): is the new `LV_MAX_EDGE=2000`
> default consistently optimal per image, or does the optimum vary?
>
> Short answer: **The per-image optimum does vary — non-monotonically
> in 4 of 14 sampled images. But 2000 remains the best FLAT
> production default; no tested alternative (2200, 2400, 2600, 2800,
> 3200) is Pareto-better on the full 340-task corpus, and dual-
> resolution ensembles inherit the secondary resolution's compliant
> regressions.**

## Apex §2.3 pre-registered hypotheses

| H | Hypothesis | How to test | Pre-registered prediction |
|---|---|---|---|
| H-A | 2000 is uniformly per-image best | sweep 7 resolutions on 14 stratified stems | per-image verdict surface flat above 1536 → adopt H-A |
| H-B | Per-image optimum varies; some labels need <2000, some >2000 | same sweep, look for non-monotonic per-image rows | non-monotonic rows present → adopt H-B |
| H-C | A dual-resolution ensemble (max-conservative) is Pareto-better than flat 2000 | run 12 pairings on the sample, then full bench on best pair | net adversarial-fp drop with ≤+1 comp regression → adopt |
| H-D | 2200 or 2800 is uniformly better than 2000 on the full corpus | full 340-task bench at each, compare to wave-31j baseline | comp.false-fail ≤ +0, adv.fp ≤ baseline-1 → adopt |

Outcome: **H-A falsified, H-B confirmed, H-C falsified on full corpus, H-D falsified on full corpus.** Production stays at 2000.

## Per-image sweep matrix (14 stems × 8 resolutions, correct condition)

```
stem                  |  1536    1800    2000    2200    2400    2600    2800    3200
----------------------|--------------------------------------------------------------------
adversarials:
ai-label-0049    (S2) | PASS    REV     REV     REV     REV     REV     REV     REV       ← any upscale catches
deg-beer-0012    (B1) | PASS    PASS    PASS    PASS    PASS    PASS    PASS    PASS      ← uncatchable
syn-beer-0014    (B1) | PASS    PASS    REV     REV     REV     REV     REV     REV       ← needs ≥2000
syn-beer-0015    (B2) | PASS    REV     REV     REV     REV     PASS    REV     REV       ← non-monotonic
syn-beer-0016    (B3) | PASS    PASS    REV     REV     PASS    REV     REV     REV       ← non-monotonic
syn-spirits-0013 (S1) | PASS    REV     PASS    REV     PASS    REV     REV     REV       ← non-monotonic (!)
syn-spirits-0014 (S3) | REV     REV     REV     REV     REV     REV     REV     REV       ← always caught

compliants:
ai-label-0001         | PASS    PASS    PASS    PASS    PASS    PASS    PASS    PASS      ← resolution-robust
ai-label-0003         | PASS    PASS    PASS    PASS    PASS    PASS    PASS    PASS      ← resolution-robust
ai-label-0017         | PASS    PASS    PASS    PASS    PASS    PASS    PASS    PASS      ← resolution-robust
ai-label-0025         | PASS    REV     REV     REV     PASS    REV     PASS    PASS      ← non-monotonic
syn-beer-0006         | REV     REV     REV     REV     REV     REV     REV     REV       ← always REVIEW

quality (GT-corrected):
ai-label-0031         | FAIL    FAIL    FAIL    FAIL    FAIL    FAIL    FAIL    FAIL      ← correctly fails (text typos)
ai-label-0050         | FAIL    FAIL    FAIL    FAIL    FAIL    FAIL    FAIL    FAIL      ← correctly fails (text typos)
```

### The non-monotonic rows (key finding)

4 of 14 stems show genuinely non-monotonic resolution sensitivity:

- **`syn-beer-0015` (B2)**: REVIEW at 1800–2400, PASS at **2600** (regression!), REVIEW at 2800+. Bold-perturbation labels' bbox-derived stroke ratios cross threshold boundaries at specific Lanczos-interpolated resolutions.
- **`syn-beer-0016` (B3)**: PASS at 1536–1800, REVIEW at 2000–2200, **PASS at 2400** (regression), REVIEW at 2600+. Same dynamics.
- **`syn-spirits-0013` (S1)**: REVIEW at 1800, **PASS at 2000 and 2400** (production default among them!), REVIEW at 2200 and 2600+. **The current production resolution 2000 actively misses this case where 2200 catches it.**
- **`ai-label-0025` (compliant)**: PASS at 1536, REVIEW at 1800–2200, PASS at 2400, REVIEW at 2600, PASS at 2800+. Roughly bimodal.

The non-monotonicity is mechanical: at each Lanczos-interpolation step the prefix bbox edge sharpness changes; combined with sharp's `threshold(128)` step inside `strokeProxy`, tiny resolution shifts cross the bold-pass threshold band irregularly.

## Aggregate verdict counts per resolution (correct condition, 14-stem sample)

| Res | adv.pass | adv.review | comp.pass | comp.review | Notes |
|---:|---:|---:|---:|---:|---|
| 1536 | 6 | 1 | 4 | 1 | pre-wave-31j baseline |
| 1800 | 3 | 4 | 3 | 2 | over-corrects |
| **2000** | **2** | **5** | **3** | **2** | **current production** |
| 2200 | **1** | 6 | 3 | 2 | catches +1 adv on sample |
| 2400 | 3 | 4 | 4 | 1 | non-monotonic recovery of compliant.true-pass |
| 2600 | 2 | 5 | 3 | 2 | |
| 2800 | **1** | 6 | 4 | 1 | catches +1 adv AND keeps compliant.pass on sample |
| 3200 | 1 | 6 | 4 | 1 | same outcome as 2800 |

Sample tells us 2800 looks Pareto-better than 2000 (1 fewer adv.fp + 1 more compliant pass). **But the full bench tells a different story.**

## Full 340-task bench: 2200 and 2800 against wave-31j baseline

| Metric | wave-31j (2000) | 2200 full bench | 2800 full bench |
|---|---:|---:|---:|
| pass-rate-on-correct | **68.6%** | 66.3% | 62.7% |
| comp.true-pass | **36** | 32 | **28** |
| **comp.false-fail** | **0** ✓ | **1** ✗ (deg-spirits-0001 broke) | 0 |
| comp.review-on-correct | 17 | 20 | 25 |
| **adv.fp-on-correct** | **2** | **1** | **1** |
| latency p50 | **3.0 s** ✓ | 4.7 s ✗ | 6.2 s ✗ |
| latency p95 | 13.7 s | 15.3 s ✗ | 17.5 s ✗ |

### Why the sample misled

The 14-stem sample has only 5 compliant stems, all robust to resolution. The broader corpus has ~10 real-photo `deg-*` labels (degraded/realistic-photo synthetic) whose normal-weight prefix is just above the bold threshold at 2000 and slips below it at 2200/2800 (the Lanczos interpolation softens body strokes more than prefix strokes, shifting the relative ratio).

**Sample-bench compliant-pass projection systematically over-estimates the broader corpus's compliant-pass rate at higher resolutions.** Lesson for future waves: sample compliants must include `deg-*` labels too.

## Dual-resolution ensemble analysis (12 pairings tested)

Ensemble = `max(rank(verdict_A), rank(verdict_B))` where pass<review<fail. Catches more adversarials at the cost of inheriting either branch's compliant regressions.

Sample-bench results (14-stem sample):

| Pair | adv.fp | comp.pass | Notes |
|---|---:|---:|---|
| 2000+2000 (single ref) | 2 | 3 | baseline |
| 1800+2000 | 1 | 3 | catches syn-spirits-0013 on sample |
| 2000+2200 | 1 | 3 | same |
| 2000+2800 | 1 | 3 | same |
| 2200+2800 | 1 | 3 | same |
| ... | | | |

All ensembles that include 1800, 2200, 2600, 2800, or 3200 catch syn-spirits-0013 (which 2000-alone misses) **on the sample**.

**But on the full corpus**, an ensemble = max-conservative inherits the secondary's compliant regressions. The 4 compliant regressions at 2200 and 8 at 2800 are all `2000=pass, 2200/2800=review` — exactly the cases the ensemble downgrades. So a full-corpus ensemble of (2000, 2800) would land at compliant.true-pass ≈ 28 (same as 2800-alone) plus the +1 adversarial catch. **Not Pareto-better than wave-31j**.

A SMART ensemble that only invokes the second resolution when the primary is confident-PASS-on-bold-but-uncertain (analogous to wave-22's same-provider second-opinion) might thread this needle. That's wave-32 architecture.

## Adaptive per-image resolution: theoretical Pareto frontier

If we could PREDICT per-image which resolution is optimal, the matrix shows we could achieve:
- 6 of 7 adversarials caught (only deg-beer-0012 is uncatchable)
- 4 of 5 compliants preserved (only syn-beer-0006 is always REVIEW)

That's strictly better than any flat resolution. But the non-monotonic rows mean the right resolution per image isn't a simple monotonic function of image features. Required signal candidates (not yet validated):

1. **Native dimensions** — useless on this corpus (all 1024×1536)
2. **OCR confidence at 1536** — possibly predictive of "Tesseract found prefix → trust SWT" vs "Tesseract failed → defer to model"
3. **VLM-self-reported bold confidence** — but the bold subscore confidence is what we're already using to gate second-opinion
4. **Image quality score** — could correlate with the right resolution but unclear direction
5. **Learned classifier** — small CNN on the 1536-version image predicting which resolution catches the most defects → ship engineering project

Wave-32 candidate: train a 10-feature logistic classifier on image stats (dimensions, mean luminance, edge density, Tesseract prefix-find success) predicting "which of {1800, 2000, 2200, 2800} is the right resolution for this image." Estimated effort: 1-2 days; estimated gain: 0-2 additional adversarial.fp catches.

## Apex §13.8a Claim Ledger

| Claim | Evidence | Status |
|---|---|---|
| 2000 is uniformly per-image best | Per-image sweep table above; 4 non-monotonic rows | **FALSIFIED** |
| Per-image optimum varies | Per-image sweep table; 4 non-monotonic rows | **CONFIRMED** |
| 2200 is Pareto-better as flat default | Full 340-bench: +1 comp.false-fail (hard fail), +57% slower | **FALSIFIED** |
| 2800 is Pareto-better as flat default | Full 340-bench: +8 compliant downgrades, 2× slower | **FALSIFIED** |
| Dual-resolution ensemble (max-conservative) is Pareto-better | Sample looks promising, but full-corpus ensemble inherits secondary regressions | **FALSIFIED on full corpus** |
| Adaptive per-image resolution could theoretically improve | Matrix shows 6/7 adv + 4/5 comp achievable | **CONFIRMED in principle**; needs signal we don't have |

## Production decision

**Keep `LV_MAX_EDGE=2000` as the production default.** No tested alternative beats it on the full corpus under the stratified guardrail.

Caveat: the 2 remaining adversarial false-passes (`deg-beer-0012` B1 and `syn-spirits-0013` S1) need a different intervention class than resolution-tuning. Per wave-31d/h:

- `deg-beer-0012`: uncatchable at any resolution. Needs narrow second-opinion (Pixtral-12B or Llama-4-Scout on bold subscore only).
- `syn-spirits-0013`: caught at 2200, 2600, 2800, 3200 but missed at 2000 and 2400 — non-monotonic. A learned-classifier adaptive-resolution rule could potentially catch it, OR the narrow second-opinion could.

## What changed in this analysis vs the previous wave-31j wrap-up

The wave-31j PR shipped with the claim "2000 is the best resolution." The exhaustive per-image analysis here refines that:

- "2000 is the best FLAT resolution" is true on the full corpus.
- "2000 is per-image optimal" is false — non-monotonic sensitivity exists.
- The 2 remaining adversarial fp's are not addressable by any flat-resolution tweak.

This doesn't change the production decision. It does sharpen the wave-32 design space: don't try more resolutions; try OCR-bypass via model-bbox + a narrow second-opinion gate.

## Artifacts (kept on branch `experiment/wave-31-survey`)

- `scripts/per-image-resolution-sweep.ts` — 8 resolutions × 14 stems × 2 conditions = 224-task sweep
- `scripts/dual-resolution-ensemble.ts` — sample-level ensemble test
- `scripts/multi-ensemble-comparison.ts` — pure analysis of 12 ensemble pairings from existing data
- `benchmarks/results/wave31/per-image-resolution-sweep.json` — raw sweep data
- `benchmarks/results/wave31/upscale-2200-fullrun.json` — full 340-task at 2200
- `benchmarks/results/wave31/upscale-2800-fullrun.json` — full 340-task at 2800
- `benchmarks/results/wave31/dual-resolution-ensemble.json` — sample ensemble result
- This document
