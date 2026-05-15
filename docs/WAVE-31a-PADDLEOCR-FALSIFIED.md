# Wave 31a — PaddleOCR replacing Tesseract.js (FALSIFIED)

> Tested whether replacing the Tesseract.js OCR layer with PaddleOCR (Apache 2.0, hosted as a Python daemon via subprocess) would attack the 5–6 deterministic adversarial false-pass cases on the cross-pair bench. **Hypothesis falsified empirically.**

## Pre-registered hypothesis

> The 5–6 adversarial false-passes (`deg-beer-0012` B1, `syn-beer-0014/15/16` B1/B2/B3, `syn-spirits-0014` S3, `ai-label-0049` S2) ALL trace to Tesseract returning `no_prefix` — the bold-detection pipeline then falls back to model self-report, which incorrectly says bold=true. Swapping in PaddleOCR (which a pre-bench 8-image preview showed finds the prefix on 4/4 adversarial cases vs Tesseract's 0/4) would let the classical-CV bold/size pipeline actually run, correctly identifying these defects.

## What we built

- `scripts/paddleocr-server.py` with a `--daemon` mode: loads PP-OCRv5 mobile detector + recognizer once, then handles line-delimited JSON requests over stdin/stdout. ~3s model load, ~0.5s steady-state per image.
- `src/lib/ocr/paddleocr.ts`: singleton daemon adapter conforming to the existing `OcrEngine` interface. Newline-framed protocol with request-id correlation for concurrency, base64-encoded image bytes (no temp files).
- `src/lib/verify.ts`: `pickOcrEngine()` picker that returns Tesseract by default, PaddleOCR when `LV_OCR_ENGINE=paddleocr`. Production-default path unchanged.
- `.venv-paddleocr/` Python virtualenv with PaddlePaddle 3.3.1 + PaddleOCR 3.5.0. Added to `.gitignore`.

## Bench result (N=1)

| Metric | Wave 28b (Tesseract baseline) | Wave 31a (PaddleOCR) | Δ |
|---|---:|---:|---:|
| pass-rate-on-correct | 71.6% | **60.9%** | **−10.7 pp** ⚠️ |
| compliant.true-pass | 40 | **27** | **−13** ⚠️ |
| compliant.review-on-correct | 31 | **44** | **+13** |
| compliant.false-fail | 1 | 1 | 0 |
| **compliant.fp-on-correct** | 0 | 0 | 0 ✓ |
| **adversarial.fp-on-correct** | 6 | **6** | **0 — predicted recovery did NOT materialize** |
| quality.true-pass | 8 | 3 | −5 |
| quality.review-on-correct | 2 | 7 | +5 |
| total p50 latency | 3.2 s | **18.0 s** | +14.8 s (5.6× slower) |
| total p95 latency | 12.5 s | 22.9 s | +10.4 s |
| errors | 2 | 2 | 0 |

## Why the hypothesis failed

Two compounding reasons:

1. **Finding the prefix isn't the same as catching the bold defect.** PaddleOCR did find prefix words on the synthetic B-cases (per the pre-bench preview). But once located, the classical-CV stroke-width-transform measurement on those crops returned `bold=pass` anyway — the synthetic generator's B1/B2/B3 perturbations subtly reduce font-weight but the SWT proxy registers them as still-bold. So the OCR upgrade didn't unblock the downstream signal that needed to flip.

2. **More confident OCR routed MORE compliant labels into REVIEW.** PaddleOCR finds prefix on many compliant labels where Tesseract returned `no_prefix`. With Tesseract's failure, the bold-fallback-only path fires the second-opinion which usually agrees on bold=pass → verdict restored to PASS. With PaddleOCR's success, the SWT actually runs — and on real-photo labels with thin or stylized fonts, the SWT ratio lands in the REVIEW band. Net: 13 compliant labels moved from `true-pass` (waving through via the second-opinion agreement path) to `review-on-correct` (correctly-but-conservatively flagged for human review).

**The deeper problem**: the second-opinion-restores-PASS pathway only fires when bold falls back to model self-report. When OCR succeeds and the SWT runs, the second-opinion doesn't help. So a "better OCR" can paradoxically degrade the headline pass-rate by removing the bold-fallback restore path's reach.

## Latency

PaddleOCR's daemon-amortized per-image cost is ~0.5s OCR + ~3s Gemini = ~3.5s total per call. But the bench observed 18s p50. The bottleneck appears to be daemon throughput under concurrency 4 (single-threaded Python process serializing requests). With sequential request dispatch and 0.5s/image, ~340 images × 0.5s = 170s of pure OCR queueing — close to the observed ~17 min total wall-clock. A multi-worker daemon would help but adds engineering complexity for a hypothesis that already failed.

## Stratified guardrail verdict

| Criterion | Verdict |
|---|---|
| compliant.fp-on-correct must not increase | ✓ (held at 0) |
| compliant.false-fail ≤ +1 | ✓ |
| Latency p50 ≤ 5 s (operational soft) | ✗ (18 s) |
| Pass-rate-on-correct must not regress >2σ | ✗ (−10.7 pp; wave-28b's noise band was ±0; this is a meaningful regression) |

Hard-criterion-wise the change is technically acceptable (regulator-critical metrics preserved). Operationally it's a net loss: 13 compliant labels lose their PASS verdict and the verifier is 5.6× slower.

## Decision

**Do not ship.** Branch artifacts remain on `experiment/wave-31-survey` for the record. Production stays on Tesseract.js.

## What this means for the broader retrospective

The retrospective's "specialist OCR" suggestion (`docs/RETROSPECTIVE-2026-05-14.md` §A4) is technically a Pareto-dominated option on this specific corpus + this specific downstream pipeline. The benefit a better OCR would unlock (sharper prefix bboxes for accurate measurement) requires that the downstream measurement actually produce useful signal — which the current SWT doesn't on the synthetic adversarials. A better OCR helps only after the SWT is also replaced with something more discriminating (a learned bold classifier, e.g.).

## Artifacts (kept on branch only, not merged)

- `scripts/paddleocr-server.py`
- `src/lib/ocr/paddleocr.ts`
- `.venv-paddleocr/` (Python venv, gitignored)
- `benchmarks/results/wave31/paddleocr-run1.json`
- This document

The `pickOcrEngine()` env-gated picker in `src/lib/verify.ts` is small (~15 lines) and harmless; it stays under feature-flag and is unreachable when `LV_OCR_ENGINE` is unset.
