# Wave 32 — Grounding DINO prefix-locator fallback (FALSIFIED at root cause)

> Built on the wave-31l empirical signal that Grounding DINO produces
> bbox candidates on the 5/6 adversarial.fp images where Tesseract
> returns 0 prefix words. The wave-32 hypothesis: crop the image to
> GD's bbox + padding, re-run Tesseract on the crop, get prefix words,
> unblock the bold-subscore SWT pipeline.
>
> **Hypothesis falsified at the root.** Tesseract's recognition itself
> is the bottleneck on these labels — not its prefix localization.
> A tighter crop produced "aN" instead of "GOVERNMENT WARNING:" because
> the synthetic perturbations make the glyphs fundamentally unreadable
> to Tesseract's LSTM regardless of crop tightness.

## What we built

- `src/lib/vision/hf/grounding-dino.ts` — Node-side singleton daemon
  adapter for `scripts/hf-server.py --model grounding-dino`. Same
  protocol as `paddleocr.ts` (wave-31a): newline-delimited JSON over
  stdin/stdout, request-id correlation, ready-emit on startup. Exports
  `detectGroundingDino()`, `pickPrefixBbox()`, `warmupGroundingDino()`,
  `shutdownGroundingDino()`.
- `src/lib/verify.ts` `tryGroundingDinoFallback()` helper — wired into
  the OCR post-processing step. When Tesseract returns >0 words but
  `findPrefixWords()` returns empty, calls GD → picks bbox → crops to
  bbox + 20% / 40% padding → re-runs Tesseract on the crop → translates
  bboxes back to image coords → merges with the original word set.
  Behind `LV_PREFIX_LOCATOR=grounding-dino` env flag; default unset
  (production unaffected).
- `scripts/wave32-targeted-bench.ts` — 11 stems × 2 conditions × 2
  variants. Adversarial.fp candidates + compliant controls.
- `scripts/wave32-debug-deg-beer.ts` — per-step diagnostic probe.

## Targeted bench result (11 stems × 2 conditions × 2 variants = 44 calls)

| Variant | adv-correct | comp-correct | wrong | p50 latency |
|---|---|---|---:|---:|
| baseline-wave31j (`LV_MAX_EDGE=2000 LV_ENLARGE=1`) | pass=2 review=5 fail=0 | pass=3 review=1 fail=0 | fail=11/11 | 9.3 s |
| gd-locate (`+ LV_PREFIX_LOCATOR=grounding-dino`) | pass=2 review=5 fail=0 | pass=3 review=1 fail=0 | fail=11/11 | 10.7 s |

**Zero verdict diffs across all 44 calls.** GD fallback fired (latency +20s
on the case where Tesseract returned 0 prefix words, confirming the daemon
ran), but the downstream subscore outputs were bit-identical.

## Root-cause diagnostic on `deg-beer-0012` (one of the 2 still-leaking adv.fps)

`scripts/wave32-debug-deg-beer.ts` instruments each step:

```
[1] Tesseract on full preprocessed image (1739 × 2000 after wave-31j upscale)
  words=47, text excerpt:
  "est MMXX aN stout PY. poNO «200 ot et pete co so a wo con® rie so a
   EY RR \ pec a nod ro PY — auied ri @ cons py of oem"  pore Ld your
   on © give? a oe os Sen" oa ae" s:"
  findPrefixWords: 0 words

[2] Grounding DINO detection
  detections=2
    box=[22,29,1706,1957]  score=0.648  label="government"  area=1684×1928
    box=[506,362,838,514]  score=0.251  label="government"  area=333×152
  picked bbox: 506,362  333×152

[3] Cropping to: x=439 y=301 w=467 h=274 (with 20%/40% padding)

[4] Tesseract on the cropped region
  words=1, text: "aN"
  findPrefixWords on crop: 0 words

[5] After translation + merge with full-image words
  mergedWords=48
  findPrefixWords on merged: 0 words
  findBodyWords:             0 words
```

**The diagnostic story:** Tesseract's recognition on the full preprocessed image returns 47 "words" but they're all garbage strings ("MMXX", "PY", "poNO", etc.) — there is no recognizable "GOVERNMENT" or "WARNING" token to be found. Tesseract is decoding the perturbed glyphs into nonsense, not failing-to-find-the-text. Re-running Tesseract on the tightly-cropped GD region returns one word: "aN". The perturbation defeats Tesseract regardless of crop tightness.

The wave-31a PaddleOCR finding ("better OCR finds the prefix on adversarials") was actually a separate signal — PaddleOCR's recognition CAN read the perturbed prefix; Tesseract's cannot. Wave-32 was attacking the wrong stage of the pipeline.

## Why GOT-OCR (the other wave-31l survivor) was not pursued

Wave-31l smoke showed GOT-OCR transcribes the full Government Warning text on `deg-beer-0012` correctly. But the bold-subscore blocker isn't "we don't have the text" — the VLM's `raw_text` already gives us the text. The blocker is "we don't have word-level bboxes to crop prefix glyphs for the stroke-width-transform measurement."

GOT-OCR produces plain text without word bboxes. Feeding its text into the validator's `raw_text` field would be redundant with the existing VLM output and wouldn't unblock the SWT path. Predicted falsification follows the same logic as the GD result: the bottleneck is bold-measurement-needs-word-bboxes, not "we need better OCR text."

## Wave-32 conclusion (Apex §13.8a claim ledger)

| Claim | Status |
|---|---|
| Grounding DINO produces useful prefix bbox candidates on adversarials | ✓ CONFIRMED (wave-31l smoke + this wave's `[2]` step) |
| Tighter cropping enables Tesseract to recognize the prefix | **✗ FALSIFIED** — synthetic perturbation defeats Tesseract recognition even on a 333×152 crop |
| GD-fallback unblocks bold-subscore SWT on adversarial cases | **✗ FALSIFIED** — 0 verdict diffs vs baseline |
| Wave-32 reaches `adversarial.fp-on-correct = 0` | **✗ FALSIFIED** — stays at 2 (same as wave-31j) |

## Wave-33+ candidates (what would actually break the deadlock)

1. **Replace Tesseract with PaddleOCR for prefix recognition only** (not whole pipeline). Wave-31a's PaddleOCR-replaces-Tesseract bench showed it finds the prefix on 4/4 of the synthetic B-cases. The PaddleOCR full-replacement was falsified because of downstream SWT regressions on compliants, but a **narrow PaddleOCR fallback** (mirror the GD wave-32 design, but with PaddleOCR-on-crop instead of Tesseract-on-crop) could capture the recognition win without the compliant trade-off.

2. **A learned bold-classifier** that takes a region crop and outputs bold/regular without needing word-level bboxes. Trained on the existing 170-image corpus + synthetic perturbations. ~1 week build.

3. **Narrow second-opinion via Pixtral-12B or Llama-4-Scout** (wave-31i finding): both achieved `adv.fp=0` as primary but at unacceptable compliant cost. As a gated third-opinion fired only on `boldFallbackOnlyPass` cases, they should harvest the adversarial win without the compliant cost.

(1) is the cheapest next-step (~half-day engineering); the PaddleOCR scaffolding from wave-31a survives on tag `v/wave-31-survey`. (3) is the highest-confidence ship per wave-31i.

## Decision

**Do not ship.** Production stays on wave-31j (`adv.fp = 2`). Wave-32
branch tagged as `v/wave-32-grounding-dino-falsified` and deleted.

## Artifacts (on tag `v/wave-32-grounding-dino-falsified`)

- `src/lib/vision/hf/grounding-dino.ts` — adapter
- `src/lib/verify.ts` — `tryGroundingDinoFallback()` helper (kept env-gated, never fires when `LV_PREFIX_LOCATOR` is unset)
- `scripts/wave32-targeted-bench.ts`
- `scripts/wave32-debug-deg-beer.ts`
- `benchmarks/results/wave32/grounding-dino-targeted.json`
- This document
