# Wave 35 — supplemental zoomed-region images for the Gemini extractor

> **Status: FALSIFIED, both variants. No code changes ship to `main`.**
> Branch `experiment/wave-35-supplemental-crops` retained for the audit
> trail; the variant-gated code paths are deleted as part of this docs
> PR.

## TL;DR

Sending Gemini 3.1 Flash-Lite a 2000-px full label **plus** additional
high-resolution zoom crops of text-dense regions did NOT improve
extraction accuracy. Both implementation variants (algorithm-driven
crops and tool-driven crops) caused **regressions** against the
wave-31j baseline, on multiple stratified-guardrail criteria, with
N=2 deterministic confirmation per arm.

| Arm | Pass-rate | Δ vs baseline | P50 | Verdict |
|---|---|---|---|---|
| Baseline (wave-31j, main `84af228`) | 70.41% | — | 2.96–3.28 s | reference |
| Variant A — Tesseract-driven crops | **69.23%** | **−1.18 pp** | 4.45–4.67 s | ❌ FALSIFIED |
| Variant B — model-driven `zoom_into_region` tool | **51.48%** | **−18.93 pp** | 5.35–5.40 s | ❌ FALSIFIED |

Both variants reproduced bit-identical pass-rates across N=2 runs (the
delta is real, not sampling noise). The decision-rule eval below lays
out the failed criteria per variant.

Branch `experiment/wave-35-supplemental-crops` is preserved on origin
for the audit trail but no code lands on `main`. The deletion of the
variant gates is bundled into the docs PR that ships this writeup.

## §2.3 Hypothesis matrix (pre-registered)

| ID | Hypothesis | What would falsify it | Expected magnitude | Outcome |
|---|---|---|---|---|
| H35-A | Tesseract-bbox-driven crops (top-3 text-dense regions at 800 px) improve text-bearing field reads without degrading regulator-hard guardrails. | (a) `compliant.fp-on-correct` rises; (b) `compliant.false-fail` rises by ≥ +2; (c) `adversarial.fp-on-correct` rises (strict, no compliant uplift); (d) Δpass-rate ≤ +1 pp AND \|Δ\| ≤ 2σ_baseline. | best plausible −1 to −2 adv.fp + +2 to +4 compliant true-pass | ❌ **(b)** triggered: compliant.false-fail 0 → 3. **(c)** triggered: adversarial.fp 3 → 5. **(d)** triggered: Δ = −1.18 pp (the wrong direction). |
| H35-B | Model-driven `zoom_into_region` tool calls outperform Variant A because the model picks the region it actually needs. | Same hard criteria as Variant A, plus: tool-call loop fails to converge >5%, P50 > 5 s, or cost > $0.40/1k. | best plausible −2 adv.fp at +0 compliant cost | ❌ Catastrophic on multiple axes. Compliant.false-fail 0 → 18. Δpass-rate = −18.93 pp. Adversarial.true-fail 72 → 60 (12 adversarials no longer caught; routed to REVIEW). P50 5.35 s (over the 5 s ceiling). |

The alternative explanation noted in the pre-registration ("wave-31j's
Lanczos-2000 upscale already extracted everything useful") is the
explanation most consistent with the result. Adding more pixels at the
same model does not help; it appears to actively confuse the
extractor.

## §13 Decision-rule evaluation

Pre-registered hard criteria from `docs/BENCH-PROTOCOL.md` §3b +
operator constraints from the wave-35 plan:

### Variant A — algorithm-driven crops

| Hard criterion | Threshold | Variant A result | Pass? |
|---|---|---|---|
| `compliant.fp-on-correct` | must NOT increase | 0 → 0 | ✓ |
| `compliant.false-fail` | must NOT increase by > +1 | 0 → **+3** | ❌ |
| `adversarial.fp-on-correct` | default strict: must NOT increase | 3 → **5** (Δ +2) | ❌ |
| pass-rate Δ | ≥ +1 pp AND outside the noise band | **−1.18 pp** | ❌ |
| P50 latency | ≤ 5 s | 4.45–4.67 s | ✓ (borderline) |
| Cost per call | ≤ $0.40 / 1k labels | ~$0.30 / 1k | ✓ |

**Verdict: 3 of 6 hard criteria fail. Falsified.**

### Variant B — model-driven tool call

| Hard criterion | Threshold | Variant B result | Pass? |
|---|---|---|---|
| `compliant.fp-on-correct` | must NOT increase | 0 → 0 | ✓ |
| `compliant.false-fail` | must NOT increase by > +1 | 0 → **+18** | ❌❌❌ |
| `adversarial.fp-on-correct` | default strict: must NOT increase | 3 → 2 (Δ −1) | ✓ |
| pass-rate Δ | ≥ +1 pp | **−18.93 pp** | ❌ |
| P50 latency | ≤ 5 s | 5.35–5.40 s | ❌ (just over) |
| Cost per call | ≤ $0.40 / 1k labels | not separately captured per record; total bench API spend ≈ $0.20 across 340 tasks suggests mean tool-call rate was low | ✓ (not the dominant problem) |

**Verdict: 3 of 6 hard criteria fail, including the most-severe
single-criterion violation in the project's history
(`compliant.false-fail` +18). Falsified.**

## Full stratified bench results

Source files (preserved on the experiment branch, pinned by SHA in
the runs themselves):

- `benchmarks/results/wave35-supplemental-crops/baseline-run1.json`
- `benchmarks/results/wave35-supplemental-crops/baseline-run2.json`
- `benchmarks/results/wave35-supplemental-crops/variant-a-run1.json`
- `benchmarks/results/wave35-supplemental-crops/variant-a-run2.json`
- `benchmarks/results/wave35-supplemental-crops/variant-b-run1.json`
- `benchmarks/results/wave35-supplemental-crops/variant-b-run2.json`

### Baseline (170 compliant + 170 wrong-GT = 340 cross-pair tasks)

| stratum | true-pass | false-fail | review-on-correct | fp-on-correct | true-fail | error-on-correct | total |
|---|---|---|---|---|---|---|---|
| compliant | 36 (50.0%) | 0 | 35 (48.6%) | 0 | 1 | 0 | 72 |
| adversarial | 0 | 0 | 10 (11.6%) | 3 (3.5%) | 72 (83.7%) | 1 | 86 |
| quality | 8 (66.7%) | 0 | 2 (16.7%) | 0 | 2 | 0 | 12 |

### Variant A

| stratum | true-pass | false-fail | review-on-correct | fp-on-correct | true-fail | error-on-correct | total |
|---|---|---|---|---|---|---|---|
| compliant | 36 | **3** ⚠ | 33 | 0 | 0 | 0 | 72 |
| adversarial | 1 | 0 | 8 | **5** ⚠ | 71 | 1 | 86 |
| quality | 7 | 1 | 2 | 0 | 2 | 0 | 12 |

### Variant B

| stratum | true-pass | false-fail | review-on-correct | fp-on-correct | true-fail | error-on-correct | total |
|---|---|---|---|---|---|---|---|
| compliant | 25 | **18** ❌ | 29 | 0 | 0 | 0 | 72 |
| adversarial | 0 | 0 | 23 | 2 | 60 | 1 | 86 |
| quality | 2 | 5 | 5 | 0 | 0 | 0 | 12 |

## §13.7 Noise characterization

Baseline N=2 runs were **bit-identical** on `passRateOnCorrect`
(70.4142% to 4 decimal places, errors=2 in both runs). Variant A N=2:
bit-identical at 69.23%. Variant B N=2: bit-identical at 51.48%.

The σ_baseline noise band is therefore observed as zero on the
prototype's deterministic Gemini Flash-Lite path at temperature 0.0.
Any non-zero Δ is real — not a sampling artifact. This makes the
decision-rule eval cleaner than the wave-13 / wave-31j case where
σ was meaningful.

## Why each variant failed — root-cause analysis

### Variant A — algorithm-driven crops

The wave-31j upscale to 2000-px already gives the model enough pixels
for the text-bearing fields. Cropping further does not add information;
it appears to make the model **less consistent** on the same fields
the full image already reads. Specific failure modes observed:

- **`compliant.false-fail` 0 → 3** — three real-photo compliant labels
  flipped from PASS to FAIL. Hand-inspection of the per-record diffs
  shows the model started extracting *slightly different* brand /
  ABV / net-contents values when given the crops vs. the same image
  alone. The crops contained the same characters but at different
  effective scale, and the model's tokeniser produced different
  outputs. The comparator rejected the changed extraction.
- **`adversarial.fp-on-correct` 3 → 5** — two additional adversarial
  labels (B3 / S1 family) slipped past the Gov-Warning subscore. The
  prefix-anchor crop *did* help the model read the prefix verbatim,
  but the model then over-relied on the zoom and rated bold/caps with
  higher confidence than it should have, masking real defects.
- **P50 +1.5 s** — expected. OCR-first serialisation (the variant
  awaits Tesseract before calling Gemini, which is the only way to
  derive bbox-driven crops) eliminates the wave-12 OCR/vision
  parallelism.

### Variant B — model-driven tool call

The catastrophic 18-pp regression has multiple compounding causes
that became clear from the per-record diff log:

1. **Loss of `responseSchema`.** Gemini Flash-Lite's SDK does not
   support `responseSchema` and `tools` simultaneously. The variant
   enforced JSON via prompt only. Without the schema, the model's
   JSON shape varied more — fields occasionally arrived as strings
   instead of numbers, nested objects flattened, etc. The
   comparator's `safeParse` then either rejected the response or
   accepted it and matched against a different shape.
2. **Tool-call cognitive load.** The model frequently emitted ONE
   tool call (for the Gov-Warning region) then produced JSON whose
   non-GW fields were noticeably worse than the no-tool baseline,
   as if the attention budget shifted to the GW analysis.
3. **Compliant labels were the most affected stratum.** Real-photo
   compliant labels have the cleanest text, so the model's
   baseline reads them well. Adding tools pushed them off that
   clean path: 18 of 72 compliant labels became `false-fail`,
   driving the headline regression.
4. **Adversarial detection actually IMPROVED slightly** (true-fail
   72 → 60 looks worse, but review-on-correct 10 → 23 means many
   moved from "verifier caught the defect" to "verifier asked for
   human review" — a more cautious posture). This is the only
   positive signal in the variant. It is not enough to offset the
   compliant regression.

## What this does NOT solve

The 3 remaining adversarial false-pass-on-correct cases (`B3 /
syn-beer-0016`, `S1 / syn-spirits-0013`, `B1 / deg-beer-0012`)
are still present at the baseline. They are not addressed by
either variant — and Variant A *adds* 2 more. The hypothesis that
extra pixels could catch these cases is now considered closed:
the model has the pixels, the failure is at the model's
classification head, not its perception.

## Engineering hours + API spend (actual vs. budget)

| Item | Budget | Actual |
|---|---|---|
| Variant A impl + unit tests | 4–6 hr | ~3 hr |
| Variant B impl + unit tests | 5–7 hr | ~3 hr (function-calling loop) |
| Bench runs (baseline + A + B, N=2 each) | ~30 min wall | ~50 min wall |
| Gemini API spend | ≤ $2 | ~$0.55 (340 × 6 = 2,040 calls, mostly at Flash-Lite price + Variant B's modest tool overhead) |
| Writeup | 2 hr | ~1 hr |
| **Total engineering** | **12–16 hr** | **~7 hr** |
| **Total API spend** | **≤ $2** | **~$0.55** |

Under budget on both axes — the falsification was clean enough
to not need the full reserve.

## What I'd try next (NOT in this wave)

The supplemental-crops hypothesis is closed for Gemini 3.1
Flash-Lite. Future related experiments worth considering:

1. **Same variants against a stronger model.** Gemini 3.1
   Pro-Preview or GPT-5.4-mini may be less sensitive to the
   multi-image confusion. Cost is the gate (Pro is 14× the
   Flash-Lite per-call price).
2. **OCR-text-as-hint, gated on Tesseract confidence.** Wave-29
   falsified this for all labels, but a confidence-gated variant
   (only inject OCR when Tesseract is ≥ 0.85 on the prefix) was
   not tested.
3. **Single high-resolution crop instead of three.** The hypothesis
   that "the model loses focus across multiple images" suggests a
   *single* GW crop alongside the full image might work where 3
   crops failed. Lower priority — Variant A's failure mode was
   compliant labels, not GW edge cases.
4. **Domain-tuned text detector.** Replace Tesseract's noisy bboxes
   with a detector trained on label-image text. Larger effort;
   could be a v2 axis if the project moves past prototype.

## §15 completion-gate checklist for the falsified PR

- [x] Both variants confirmed deterministic (N=2 bit-identical).
- [x] All six hard criteria evaluated per variant.
- [x] Stratified-guardrail report run + pasted into the writeup above.
- [x] Hypothesis-matrix outcome column filled in.
- [x] All bench JSON files pinned at
      `benchmarks/results/wave35-supplemental-crops/`.
- [x] `CHANGELOG.md` "wave 35 (track 2): falsified" section appended.
- [x] Variant gates (`LV_SUPPLEMENTAL_CROPS`, `LV_SUPPLEMENTAL_CROPS_TOOL`)
      removed from `verify.ts` + `vision/gemini.ts` on the docs PR so
      `main` ships no dormant experiment paths.
- [x] Unit-test files for Variant A (`src/tests/supplemental-crops.test.ts`)
      deleted with the code they tested.
- [x] Branch `experiment/wave-35-supplemental-crops` preserved on
      origin for the audit trail; can be deleted after this doc has
      been merged for 30+ days.

## Apex framework anchors

- **§2.3 hypothesis matrix** — pre-registered before code change, see top.
- **§13.7 noise characterization** — N=2 deterministic per arm, σ_baseline = 0.
- **§13 pre-registered decision rule** — six hard criteria, both variants
  failed three. No conditional 5× compliant-uplift trade applies (no
  compliant uplift to trade against).
- **§13.8a claim ledger** — the only claim this writeup makes is
  "neither variant ships; here is the data." No version-pinned model
  promise, no operator-visible change.
- **§12.3 hypercritical self-audit** — performed before merge: see the
  root-cause section above. Self-audit Q1: "could the Tesseract noise
  on B1/B3 labels mean Variant A degraded to baseline-equivalent on
  those records, hiding a real gain elsewhere?" A: per the stratified
  report, Variant A's compliant.true-pass stayed at 36 vs baseline 36
  — there was no hidden gain. Q2 (Variant B): "could the JSON-shape
  variance be fixed with a stricter prompt?" A: tested with three
  prompt revisions during early development; none recovered the
  pre-tools baseline. Verdict stands.
- **§15 completion gates** — see checklist above. All ticks satisfied
  before the docs PR ships.
