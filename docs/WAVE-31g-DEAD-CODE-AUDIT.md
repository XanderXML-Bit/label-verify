# Wave 31g — Dead-code audit (for future cleanup, not yet executed)

> Following sub-agent §3 in the wave-31 architectural review. Each item
> was verified independently before listing. Cleanup is **not yet
> executed** — the items live in production source today but are
> reachable only via env-flagged research paths that are unset by
> default. Listed for the user's approval before any deletion.

## 1. OCR-hint prompt-injection scaffolding

**Files**: `src/lib/vision/prompt.ts:38` (`buildOcrHintSection`), and
call sites in:
- `src/lib/vision/anthropic.ts:10,67`
- `src/lib/vision/gemini.ts:10,163`
- `src/lib/vision/openai.ts:10,158`
- `src/lib/vision/openrouter.ts:10,225`

**Status**: Dead at runtime in production, exercised only by unit tests
(`src/tests/extractors.test.ts:157`, `src/tests/openrouter.test.ts:332`).
Production `verifyLabel` never passes `ctx.ocrText` — it was tested
under C1 hypothesis and falsified (OCR-text in prompt degraded
extraction). The call sites currently invoke `buildOcrHintSection(undefined)`
which returns an empty string.

**Recommended action**: Document with a top-of-file comment that this
is "falsified C1 scaffolding kept for the test record." Don't delete —
the tests use it to verify the contract that "if a future caller
passes ocrText, it's properly injected." Removing the function would
remove that contract.

**Effort**: 15 min (one block comment in `prompt.ts`).

## 2. PaddleOCR adapter in production source

**Files**:
- `src/lib/ocr/paddleocr.ts` (full adapter, ~256 lines)
- `src/lib/verify.ts:10-21` (`pickOcrEngine` env switch)

**Status**: Reachable only when `LV_OCR_ENGINE=paddleocr`. Falsified
in wave-31a (documented in `docs/WAVE-31a-PADDLEOCR-FALSIFIED.md`).
The adapter requires a Python daemon at `scripts/paddleocr-server.py`
and a `.venv-paddleocr` virtualenv — neither deployable on Vercel.

**Recommended action**: Move to a `bench-only/` directory or behind an
`if (process.env.NODE_ENV === "production") throw` guard so a typo'd
env var can't accidentally route production traffic through a
non-deployable path.

**Effort**: 30 min plus tests.

## 3. OpenRouter / Llama-4 / Qwen3-VL primary-extractor switch

**File**: `src/lib/verify.ts:1054-1124` (`buildDefaultExtractor`,
`openrouter` branch).

**Status**: Reachable only when `MODEL_PRIMARY_PROVIDER=openrouter`.
Wave-31c (Qwen3-VL) and wave-31d (Llama-4-Scout) both falsified.
Production-default `google` branch is unaffected.

**Recommended action**: Keep — the OpenRouter branch is small (~30
lines) and the wave-31d narrow-second-opinion follow-up depends on
this plumbing. Cleanup not warranted.

**Effort**: N/A — leave in place.

## 4. `fontBoldFraction*` low-signal branches

**File**: `src/lib/validation/government-warning-validator.ts:247-261`
(LSTM Tesseract `is_bold` consumer).

**Status**: Comment at line 300 documents that LSTM Tesseract doesn't
populate `is_bold` reliably; in practice these branches receive `null`
on the vast majority of runs. They add complexity for a signal that
rarely fires.

**Recommended action**: Instrument first — add a counter in the bench
runner that tracks how often `fontBoldFractionPrefix !== null`. If
the rate is <2% across the 340-task bench, delete the branches. If
higher, keep them. **Do not delete blind.**

**Effort**: 1 hour for instrumentation + decision.

## 5. Wave-31f flags (`LV_STROKE_THRESHOLD`, `LV_BODY_RELATIVE_SIZE`)

**Files**: `src/lib/validation/bold-size.ts:319-330, 437-475`,
`src/lib/validation/government-warning-validator.ts:103-130`.

**Status**: Both flags were tested in this wave and falsified at OCR
layer (`docs/WAVE-31f-OTSU-BODYREL-FALSIFIED.md`). The
implementations are correct in intent but blocked by the upstream
Tesseract-prefix-find failure.

**Recommended action**: Keep — wave-32 may unblock OCR via
model-bbox-driven body-words search, at which point both flags become
useful again. The flag-gated path is a no-op when env is unset.

**Effort**: N/A — leave in place.

## Net effect of executing the full cleanup

- ~30 lines deleted (`pickOcrEngine` move) + ~280 lines moved
  (`paddleocr.ts` to `bench-only/`)
- 1 file relocation
- 2 sets of unit tests updated (paths only)
- Zero production behaviour change

**This is a 2-3 hour cleanup, defer to a separate PR after the wave-31
research artifacts have been on the branch long enough for any
follow-up to land.**

## Decision

**Document but defer.** Production-default paths are unaffected by any
of the dead-code items. The cleanup is hygiene work, not a functional
improvement, and rolling it into the wave-31 deliverable would
conflate "we explored these options and they don't ship" with "we
deleted the scaffolding." Keep both messages cleanly separable.
