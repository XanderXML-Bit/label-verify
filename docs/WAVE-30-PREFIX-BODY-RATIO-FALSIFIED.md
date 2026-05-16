# Wave 30 — prefix/body OCR ratio as size signal (FALSIFIED before bench)

> Tested whether a deterministic OCR-measured ratio of prefix-bbox-height to body-text-bbox-height could discriminate synthetic adversarial S-cases (where prefix is intentionally shrunk) from compliant labels (where prefix is typically larger than body). This was an attempt to do the wave-21 hypothesis correctly — measure the ratio instead of asking the model. **The empirical ratios overlap between strata. Hypothesis falsified at the pre-bench measurement stage.**

## Pre-registered hypothesis

> Synthetic S-cases (where the generator scales the prefix to 0.45× normal) will have OCR-measured `prefix_height / body_median_height` ratios materially smaller than compliant labels. A threshold near 0.85 should catch the synthetic adversarials without false-failing compliant labels.

## Method

`bin/measure-prefix-vs-body.ts` script:
1. Runs the same Tesseract OCR + preprocessing the validator uses.
2. Uses the validator's `findPrefixWords` and `findBodyWords` (same algorithms as `government-warning-validator.ts`).
3. Reports `max(prefix bbox heights) / median(body word bbox heights)`.

## Measured ratios (n=18 sample)

### Compliant stratum

| Image | Ratio |
|---|---:|
| ai-label-0005 (C0) | 2.00 |
| ai-label-0016 (C0) | 1.94 |
| ai-label-0035 (C0) | 1.62 |
| ai-label-0070 (compliant) | 1.36 |
| ai-label-0078 (compliant) | 1.11 |
| ai-label-0063 (compliant) | 0.94 |
| **ai-label-0062 (compliant)** | **0.75** ← lower than any synthetic S |
| ai-label-0004, 0061, 0066 (compliant) | no_prefix (Tesseract couldn't find prefix) |

### Adversarial S-stratum

| Image | Ratio |
|---|---:|
| **ai-label-0049 (S2_MINI_TINY_TEXT)** | **1.29** ← higher than several compliant cases |
| ai-label-0046 (S2_WARNING_TOO_SMALL) | 1.00 |
| syn-spirits-0013 (S1) | 1.00 |
| syn-beer-0017 (S2) | 0.92 |

### Adversarial B-stratum

| Image | Ratio |
|---|---|
| deg-beer-0012, syn-beer-0014/15/16 (B1/B2/B3) | no_prefix (Tesseract can't find prefix) |

## Why the hypothesis fails

The synthetic generator's `prefixSizeMul = 0.45` is applied to a normal-prefix baseline that is *already proportional to body*. The resulting prefix is not "tiny" in absolute or relative terms — it's *the same size as the body or slightly smaller*. Tesseract's measured prefix bbox is comparable to its body bboxes (ratios 0.9-1.0) because the synthetic generator deliberately preserves visual legibility — the defect is regulatory (too small per §16.22 absolute mm), not visual.

Meanwhile, compliant real-photo labels have ratio spread 0.75-2.00 driven by font choices, image angle, and OCR bbox jitter. The ratio-0.75 compliant case (`ai-label-0062`) is a perfectly compliant label with a typographically thinner prefix that Tesseract measured as smaller-than-body.

The two distributions overlap meaningfully in the 0.9-1.3 range. No single ratio threshold separates them.

## Sister insight: the B-cluster has no prefix at all

The deg-beer-0012, syn-beer-0014/15/16 B1/B2/B3 cases all return `no_prefix` from Tesseract — the bold defect in the synthetic generator renders the prefix in a way Tesseract can't OCR. The bold subscore falls back to model self-report, which incorrectly says bold=true, and the existing bold-fallback-only-PASS path then restores PASS via second-opinion agreement. These cases are unfixable via OCR-derived size or boldness ratios — they need either better OCR or a different signal entirely (e.g., a learned region detector that finds the prefix region by visual layout rather than text recognition).

## Decision

**Do not implement.** The empirical signal doesn't discriminate strata. Documenting on the wave-29-style negative-result record.

## Apex framework anchors

- §13.7 noise characterization: ratios within compliant stratum span 0.75–2.00 (n_body 2–42); this noise band overwhelms any inter-stratum signal.
- §13.8a claim ledger: the retrospective hypothesis "OCR-measured prefix/body ratio is the right implementation of the wave-21 size signal" is updated to "falsified empirically on this corpus".

## What's left structurally

After waves 28b (shipped) + 29 + 30 (falsified), the remaining size-channel options are:

1. **Region detection for the printed-label bbox** — gives a real px↔mm anchor instead of relying on long-edge-of-photo. Requires either a VLM call ("return the label quadrilateral") or a classical CV pipeline. Not pursued this session.
2. **Higher-resolution OCR on a cropped GW region** — combines with #1.
3. **Fine-tuning** — out of scope for this prototype.

## Artifacts

- `bin/measure-prefix-vs-body.ts` — measurement script (kept; useful for future size-channel design work).
- `/tmp/wave30-v2.out` — raw measurements (not committed).
- This document.
