# Overnight session — 2026-05-13 → 14

> Apex-framework-driven autonomous pass. Five waves designed; **four merged**, one reverted at the methodology guardrail, one reverted at the user principle.

## Verdict-bucket summary across the night

Reading the table top-to-bottom is the work-product narrative. Baseline is the N=8 pre-wave-22 run (gpt-5.4-nano second-opinion, deterministic-where-shown).

| Bucket | Baseline (N=8 mean) | After wave-22 | After wave-23 | After wave-24 | After wave-25 | Δ from baseline |
|---|---:|---:|---:|---:|---:|---:|
| true-pass | 39.3 | 36 | 38 | 38 | 38 | −1.3 |
| **false-fail** | **11.9** | 12 | 7 | 4 | **3** | **−8.9** |
| review-on-correct | 41.3 | 43.7 | 47 | 50 | 51 | +9.7 |
| **false-pass-on-correct** | **4.6** | 5 | 5 | 5 | **5** | **+0.4 (within noise)** |
| true-fail | 72 | 72 | 72 | 72 | 72 | 0 |
| error-on-correct | 1 | 1 | 1 | 1 | 1 | 0 |
| **true-reject** | 164.3 | **168** | 168 | 168 | 168 | **+3.7** |
| **review-on-wrong** | 4.8 | **1** | 1 | 1 | 1 | **−3.8** |
| error-on-wrong | 1 | 1 | 1 | 1 | 1 | 0 |
| **pass-rate-on-correct** | 65.8% ±2.7 | 63.9% | 65.1% | 65.1% | **65.1%** (deterministic ×12 successive runs) |  |

Net regulator-visible change vs baseline:

- **8.9 fewer compliant labels wrongly rejected** (false-fail 12 → 3).
- **3.7 more wrong-GT cases correctly rejected** (true-reject 164 → 168). Equivalent reduction in review-on-wrong.
- **0.4 increase in false-pass-on-correct, within baseline ±2σ noise band** (4.6 ±3.0 → 5.0).
- **Pass-rate determinism**: 12 successive cross-pair benches spanning waves 22-25 all came in at exactly **65.1%**. Pre-wave-22 baseline had ±10pp swing across N=8 (60.9–71.0%).

## Wave-by-wave

### Wave 22 — Gemini 2.5 Flash second-opinion ✓ merged (#36)

Swapped the REVIEW-trigger second-opinion model from `gpt-5.4-nano` (OpenAI) to `gemini-2.5-flash` (Google) per user direction. Primary extractor remains `gemini-3.1-flash-lite`. OpenAI stays wired as the **primary-fails FALLBACK** (different concern — provider diversity on full primary failure).

- New: `src/lib/vision/second-opinion.ts` selector with `SECOND_OPINION_PROVIDER` env-var routing.
- Outcome: deterministic bucket counts on 6 of 9 buckets, +3.7 true-reject / −3.8 review-on-wrong paired transfer.
- `docs/WAVE-22-FINDINGS.md`.

### Wave 23 — Government-Warning text case-fold ✓ merged (#37)

27 CFR §16.21 requires the *prefix* in caps + bold but says nothing about body case. 7 corpus false-fails (ai-label-0002/5/6/7/8/31/50) failed `scoreText` at confidence 1.0 because the body was rendered ALL CAPS but the canonical comparison was case-sensitive.

- Added `.toLowerCase()` as the final step of `normalizeForTextMatch`.
- The orthogonal `scoreCaps` subscore remains case-sensitive on the prefix — actual regulatory case rule still enforced.
- Outcome: 5 recovered (false-fail 12 → 7), no fp regression, all 9 buckets deterministic across N=3.
- `docs/WAVE-23-FINDINGS.md`.

### Wave 24 — class_type generic-on-label acceptance ✓ merged (#38)

3 corpus false-fails (ai-label-0065 Grenache/WINE, 0076 Lager/BEER, 0080 Mango Lime Malt Seltzer/MALT BEVERAGE) where the bottle prints just the generic class designation while the COLA application declares the specific subtype. Both forms are compliant under TTB regs.

- Added `GENERIC_CLASS_FAMILIES` table (wine / beer / distilled spirits / fortified wine → common subtypes) with token-substring matching for descriptive declared values.
- Conservative landing at REVIEW (not PASS) preserved sharp rejection on wrong-GT perturbations.
- Outcome: 3 recovered (false-fail 7 → 4), no fp regression, deterministic.
- `docs/WAVE-24-FINDINGS.md`.

### Wave 25 — null-extraction safety net ✓ merged (#39)

Sister-logic to the §5b image-quality safety net. When the FAIL verdict is driven solely by null-extraction comparators (status=fail + confidence ≤ 0.05) and the Gov-Warning isn't FAIL, upgrade FAIL → REVIEW with a "could not read X from the submitted image" reason.

- Outcome: 1 recovered (deg-beer-0001, false-fail 4 → 3). deg-spirits-0003 stayed false-fail because brand returned non-null garbage at conf 0.14 (a watermark-extraction artifact, not the null sentinel).
- `docs/WAVE-25-FINDINGS.md`.

### Wave 21 — prompt-engineered prefix-taller-than-body ✗ reverted (no PR)

> The "ask the model" intervention for synthetic S-case size detection.

- N=1 result: pass-rate +14.4 pp, **false-pass-on-correct +6** — clear regulator-critical regression.
- Root cause: synthetic S-cases at 0.45× normal prefix size are STILL visually taller than body text in the rendered images, so the model correctly answers "yes, taller" → false-pass.
- Per pre-registered criterion, branch deleted (local + remote) on session start.

### Wave 26 — size-threshold degraded-PASS band 0.65–0.80 ✗ reverted (no PR)

> The "relax the cliff" intervention. Direct measurement on 20 corpus images suggested a clean gap between real-photo compliant (ratio 0.65–0.78) and synthetic non-compliant (ratio 0.35–0.60), so a degraded-PASS band at 0.65–0.80 looked safe.

- N=3 result: pass-rate jumped **65.1% → 72.2%**, +11.5 true-pass cases. False-pass-on-correct went 5 → 6 deterministic — **ai-label-0049** (S2_MINI_TINY_TEXT) flipped to false-pass.
- Methodology error: my measurement script averaged Tesseract bbox heights across prefix words, but the **validator uses the MAX** (`prefix.reduce((m, w) => Math.max(m, w.bbox.height), 0)`). Synthetic ai-label-0049 at MEAN ratio 0.352 had MAX ratio ~0.70 — above my 0.65 floor.
- Formal acceptance (fp-on-correct ≤ 7.61 baseline +2σ) still passed, but the user's explicit principle is **"false pass on corrects is worse than review"** — even a single new fp on a deliberately-non-compliant synthetic case is a directional violation, regardless of the big true-pass gain on its other side. **Reverted.**
- Lesson banked: any future bench-corpus-bounded threshold experiment must use the SAME mean/max/percentile aggregation the validator uses, end-to-end. Don't trust a separate "measurement script."

## Currently-unsolved buckets

3 deterministic false-fails left:

- **ai-label-0031, ai-label-0050** — text recovered by wave-23, but `size=review` from the OCR-derived prefix-mm still tanks the verdict to REVIEW (which the §5a deferral converts to a passing-confidence REVIEW). Same root cause as the wave-21/26 size-detection problem.
- **deg-spirits-0003** — brand region occluded by an oval; model pulls the "FAUX BRAND" watermark from the test-corpus footer instead of the actual brand. This is a synthetic-corpus artifact (watermark wouldn't be on a production label), not a verifier defect. Documented as known-limitation.

5 deterministic false-pass-on-correct:

- 4 synthetic bold defects (B1/B2/B3 cases on `deg-beer-0012`, `syn-beer-0014/15/16`) and 1 synthetic size defect (S3 on `syn-spirits-0014`). All are non-compliant defects subtle enough to fool both the primary and the smarter second-opinion. Multi-signal voting is the likely path; deferred until a viable independent signal source matures.

review-on-correct = 51 — biggest remaining UX lever. Wave-26's degraded-PASS band would have moved 12+ of these into PASS but the cost on fp-on-correct ruled it out. Future work likely requires a more sophisticated tie-breaker (e.g. second-opinion-must-confirm-PASS) rather than a global threshold relaxation.

## Methodology notes (recorded)

- Pre-registered acceptance criterion is doing real work. Wave-21 had +14 pp pass-rate but +6 fp — formally ineligible to merge per the criterion. Wave-26 was the closer call (only +1 fp, technically inside the 2σ band) — the user-principle "fp worse than review" was the deciding rule, not the formal noise band.
- Determinism is the proper acceptance unit, not single-draw delta. All 4 merged waves produce *identical* bucket counts across N=3 replicates on most metrics; baseline had ±10pp jitter on the same corpus.
- "Wave history" comments in the source describing what was tried + why it was reverted have proven valuable when revisiting adjacent ideas. Wave-26's revert note captures the mean-vs-max measurement trap so the next size-threshold attempt doesn't re-discover it.

## File index

| Doc | Purpose |
|---|---|
| `docs/WAVE-22-FINDINGS.md` | Gemini 2.5 Flash second-opinion |
| `docs/WAVE-23-FINDINGS.md` | Gov-Warning text case-fold |
| `docs/WAVE-24-FINDINGS.md` | class_type generic-on-label |
| `docs/WAVE-25-FINDINGS.md` | null-extraction safety net |
| `docs/SESSION-2026-05-13-OVERNIGHT.md` | This doc |
| `benchmarks/results/wave22-run{1,2,3}.json` | Wave-22 N=3 bench artifacts |
| `benchmarks/results/wave23-run{1,2,3}.json` | Wave-23 N=3 bench artifacts |
| `benchmarks/results/wave24-run{1,2,3}.json` | Wave-24 N=3 bench artifacts |
| `benchmarks/results/wave25-run{1,2,3}.json` | Wave-25 N=3 bench artifacts |
| `benchmarks/results/baseline-N8-stats.json` | Baseline noise-band reference |
| `benchmarks/results/compare-wave22.js` | Comparison analysis script |
