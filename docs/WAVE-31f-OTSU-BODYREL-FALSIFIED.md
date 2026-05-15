# Wave 31f — Otsu thresholding + Body-relative-size (FALSIFIED at OCR layer)

> Implemented the two sub-agent-flagged classical-CV interventions
> (`LV_STROKE_THRESHOLD=otsu` in `strokeProxy`, `LV_BODY_RELATIVE_SIZE=1`
> as a 5th-subscore-style size downgrade). **Both falsified at chosen
> thresholds** — and the diagnostic revealed *why*: the 6 adversarial
> false-passes share a common upstream root cause that neither
> intervention can reach.

## What we built

1. **Otsu thresholding** (`src/lib/validation/bold-size.ts` — `strokeProxy`,
   `otsuThreshold` helper).
   - Behind `LV_STROKE_THRESHOLD=otsu`.
   - Computes the greyscale histogram of each cropped word bbox, then
     picks the threshold that maximises between-class variance.
   - Replaces the fixed `.threshold(128)` for ink that isn't pure black.
   - ~25 lines added; production default unchanged.

2. **Body-relative size downgrade**
   (`src/lib/validation/bold-size.ts` — `measureBodyRelativeSize`;
   wired in `government-warning-validator.ts`).
   - Behind `LV_BODY_RELATIVE_SIZE=1`.
   - Computes `prefix_height_max / body_height_median` from OCR.
   - If size subscore was PASS but ratio < 1.0, downgrade to REVIEW.
   - Rationale: scale-invariant prominence measure, avoids the
     "pxPerMm is a constant after 1600 long-edge resize" problem.

## Bench result (4 cells × 46 tasks each, same 23-image stratified sample)

| Variant | correct.pass | correct.fail | correct.review | wrong.fail | wrong.pass |
|---|---:|---:|---:|---:|---:|
| baseline | 20 | 2 | 1 | 23 | 0 |
| `LV_STROKE_THRESHOLD=otsu` | 20 | 2 | 1 | 23 | 0 |
| `LV_BODY_RELATIVE_SIZE=1` | 20 | 2 | 1 | 23 | 0 |
| both | 20 | 2 | 1 | 23 | 0 |

**Per-stem verdict diffs: zero across all three variants vs baseline.**
Neither intervention moves any verdict on the sample.

## Why (root-cause diagnostic)

Wrote `scripts/bodyrel-debug.ts` to dump the prefix/body OCR counts and
the body-relative ratio for the 6 adversarial.fp-on-correct cases plus
3 compliant controls. Result:

```
ai-label-0049        ratio=1.38 prefix=40px medianBody=29px (prefixWords=2 bodyWords=30)
deg-beer-0012        br=null (prefix=0 body=0)
syn-beer-0014        br=null (prefix=0 body=0)
syn-beer-0015        br=null (prefix=0 body=0)
syn-beer-0016        br=null (prefix=0 body=0)
syn-spirits-0014     br=null (prefix=0 body=0)
ai-label-0001        ratio=2.28 prefix=66px medianBody=29px (prefixWords=2 bodyWords=27)
ai-label-0003        ratio=1.04 prefix=24px medianBody=23px (prefixWords=2 bodyWords=35)
ai-label-0017        ratio=1.41 prefix=31px medianBody=22px (prefixWords=2 bodyWords=33)
```

**5 of 6 adversarial.fp cases have prefix=0 body=0 from Tesseract.**
This matches wave-31a's PaddleOCR pre-bench observation (Tesseract
finds 0/4 of the synthetic B-cases). Without prefix words located, the
`strokeProxy` is never called (so Otsu's threshold choice is
irrelevant), and `measureBodyRelativeSize` returns null (so the
downgrade gate never fires).

The 6th case (`ai-label-0049`) shows ratio=1.38 — well above the 1.0
threshold, so body-rel correctly leaves the verdict at PASS (which is
the wrong answer per GT, but body-rel never claimed to catch S2
synthetic perturbations at ratio 1.38).

## What this falsification tells us

The 6 adversarial false-passes share a common upstream root cause: **on
this corpus subset, Tesseract.js's OCR completely fails to find the
prefix.** When that happens:
1. `strokeProxy` is not invoked → Otsu doesn't matter.
2. Bold pipeline falls back to model self-report.
3. Model self-reports `prefix_appears_bold=true`.
4. Second-opinion (Gemini 2.5 Flash) confirms.
5. Verdict: PASS.

No classical-CV thresholding change inside `strokeProxy` reaches these
cases because `strokeProxy` is never called on them. No body-relative-
size sanity check reaches these cases because there's no body or
prefix to compare.

The wave-31a PaddleOCR experiment fixed step 1 (OCR finds the prefix)
but broke step 2-5 in a new way: when `strokeProxy` ran on the
PaddleOCR-located prefix, the actual stroke-width measurement returned
`bold=pass` because the synthetic perturbation is subtle enough to
fool SWT directly. So the architecture has **two compounding
defenses** that both have to work — and on the synthetic adversarials,
one or the other always fails.

## The unfortunately-narrow remaining options

(All out of scope for wave-31; recorded for future waves.)

1. **OCR-free bold detector**: replace `strokeProxy`'s OCR-bbox dependency
   with a model-bbox-guided crop (use the VLM's reported
   `prefix_bbox`, which IS populated even when Tesseract fails). Crop
   on the model's bbox, then run the existing or Otsu-thresholded
   SWT. This decouples step 1 from step 2.

2. **Learned bold classifier**: a small CNN trained on a few hundred
   bold-vs-regular crops would beat SWT on subtle perturbations.
   Real engineering cost (~1 day), uncertain win because the
   training data is synthetic-perturbation-class which doesn't
   transfer perfectly to real labels.

3. **Llama-4-Scout as narrow second-opinion** (wave-31d follow-up).
   Skip the OCR-based bold detection entirely; ask Llama-4-Scout
   "is this prefix rendered in heavier weight than the surrounding
   text?" on the crop. Llama-4-Scout's catastrophic-on-primary
   regression suggests it's conservative on bold — exactly the
   bias we want for an adversarial defender.

4. **GT-correction + accept the residual**: the 6 false-passes are all
   synthetic adversarials. The bench's "gold truth" treats them as
   "compliant with a bold defect we want the system to flag." If
   real-world labels don't actually exhibit this exact subtle-bold-
   reduction pattern (because real-world bold mistakes are coarser),
   the bench is over-fitting our system to a synthetic distribution.
   Reframe: production protects on regulator-coarse defects; the 6
   adversarial fp are a known synthetic-only limitation.

## Decision

**Do not ship.** The two flags remain implemented behind
`LV_STROKE_THRESHOLD` and `LV_BODY_RELATIVE_SIZE` for future
experimentation but are no-ops with their current defaults.

The diagnostic itself — that 5/6 adversarial.fp cases lose at the OCR
layer — is the wave-31's most useful finding. It eliminates two
plausible-sounding interventions and re-focuses any future wave-32 on
the OCR-bypass or learned-bold direction, not on heuristic tuning.

## Artifacts

- `src/lib/validation/bold-size.ts` — `otsuThreshold`, `measureBodyRelativeSize`, env-flagged strokeProxy
- `src/lib/validation/government-warning-validator.ts` — env-flagged size downgrade
- `scripts/otsu-bodyrel-bench.ts` — 4-cell bench
- `scripts/bodyrel-debug.ts` — root-cause diagnostic
- `benchmarks/results/wave31/otsu-bodyrel-run1.json`
- This document
