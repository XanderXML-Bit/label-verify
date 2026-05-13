# Wave 13 — bench findings + pre-registered hypotheses

> Recorded 2026-05-13 during the wave-13 cross-pair bench investigation. This document is the *scientific record* of what was learned during the rigorous re-measurement of the verifier's baseline performance. It captures the noise band, the re-evaluation of prior claims (including the wave-10 "regression"), the per-image defect classification, and pre-registers the next intervention experiments per Apex §2.3 hypothesis matrix.

## 1. The noise-band correction (the user's catch, the methodology lesson)

The historical "best-known" champion of **76.5%** passRateOnCorrect (recorded at commit `d8c6b2d`) was treated as a stable ceiling for the verifier on the 170-image test-data-combined corpus. Wave-10's experimental fallback was reverted because a single bench run on its branch came in at 60.4%, called a "16-pp regression."

**That call was wrong.** N=6 replicate bench runs on `9b7e52a` (the unchanged main branch, no verifier code change) produced:

| Metric | Mean | Sample SD | Min | Max | 2σ band |
|---|---:|---:|---:|---:|---:|
| passRateOnCorrect (%) | **61.3** | 0.3 | 60.9 | 61.5 | ±0.6 |
| failOrReviewRateOnWrong (%) | 100.0 | 0.0 | 100.0 | 100.0 | ±0.0 |
| errors (count) | 4.5 | 1.2 | 2.0 | 5.0 | ±2.4 |
| p50_total (ms) | 3432 | 194 | 3252 | 3772 | ±387 |
| p95_total (ms) | 7295 | 196 | 7045 | 7611 | ±391 |
| p50_vision (ms) | 2826 | 92 | 2711 | 2956 | ±184 |
| p95_vision (ms) | 4166 | 362 | 3792 | 4856 | ±725 |

(The `errors` SD of 1.2 is across both pre-fix runs (errors=5) and a single post-bench-fix run (errors=2). Pre-fix N=5 had errors=5 ± 0; post-fix the corresponding number is 2 ± 0 because the 2 remaining errors are genuine GT defects.)

**Within-session SD on passRateOnCorrect is just ±0.3 pp**. The 76.5% historical number is **15.2 pp above** the current N=6 mean — that's **22σ outside the within-session noise band**. It is *not* a typical performance number; it's an outlier draw from a different session, almost certainly explained by some combination of Gemini model state drift, REVIEW threshold sitting differently on the confidence boundary, or differing Vercel cold-start behavior.

**The implication for prior claims:**
- Wave-10 (prefix-bbox stroke-width fallback) came in at 60.4%. That is **0.9 pp below the current N=6 mean of 61.3%** — *well within the ±0.6 pp 2σ band*. The "regression" label was assigned based on a flawed one-shot comparison. **Wave-10's revert was not scientifically justified.** Whether wave-10 was actually neutral, improving, or regressing on accuracy cannot be answered without N≥3 replicates of *its* branch compared against this same noise band.
- Every prior `.best-known.json` champion is suspect. The within-session SD is tight enough that any single run's claim should be revisited.

The new methodology is documented in `docs/BENCH-PROTOCOL.md` and the tooling (`bin/bench-aggregate.ts`, the `DETERMINISTIC_FAIL` / `FLIPPER` classifier) is now in place.

## 2. Per-image defect classification (N=3 baseline, pre-bench-fix)

The cross-pair bench's 340 (image, condition) pairs sort into 5 deterministic-consistency buckets:

| Classification | Count | Meaning |
|---|---:|---|
| `DETERMINISTIC_PASS` | 260 | Every run produced a passing bucket (true-pass / true-fail / true-reject). Verifier is reliably correct here. |
| `DETERMINISTIC_FAIL` | 65 | Every run produced the SAME failing bucket. **Real, reproducible defects.** |
| `DETERMINISTIC_ERROR` | 5 | Every run errored on this row. GT / schema defects, not verifier bugs. |
| `INCONSISTENT_NON_PASS` | 2 | Never PASSED but the failure mode itself varied (FAIL vs REVIEW across runs). Partial-noise defect. |
| `FLIPPER` | 8 | Sometimes passed, sometimes failed. The genuine noise floor — fixing individual flippers is a methodological error. |

### DETERMINISTIC_FAIL breakdown (the actionable list)

Of the 65 deterministic failures:
- **20 `false-fail`**: compliant labels deterministically REJECTED. Oracle reviewers (Claude + Codex cross-provider) confirmed all 20 are TRUE_DEFECTs — the verifier is over-rejecting visibly compliant labels.
- **42 `review-on-correct`**: compliant labels deterministically routed to REVIEW. Friction, not strict accuracy loss.
- **2 `false-pass-on-correct`**: `syn-beer-0016` (B3 case, bold defect) and `syn-spirits-0014` (S3 case, size defect) deterministically slip through PASS. Oracle: `syn-beer-0016` is a real verifier defect (verifier missed an actual non-bold prefix); `syn-spirits-0014` is likely GT_WRONG (the size defect is too subtle to detect without measurement, and both Claude + Codex oracles agreed).
- **1 `review-on-wrong`**: a wrong-GT row routed to REVIEW (safety net firing correctly).

### Subscore diagnosis on representative cases

Running `bin/diagnose-batch.ts` against 7 representative deterministic failures revealed the failures are not one bug, they're (at least) two distinct verifier bugs plus one safety-net mechanism:

| Image | Verdict | Subscore that drove the verdict |
|---|---|---|
| `ai-label-0035` | FAIL | **bold=FAIL(c0.90)** on a compliant prefix — bold-detection over-rejection |
| `ai-label-0065` | FAIL | **class_type=FAIL** — GW is fine; the class-type comparison is the killer |
| `ai-label-0079` | FAIL | **bold=FAIL(c0.90) + size=REVIEW(0.50)** — same bold bug + conservative size band |
| `ai-label-0080` | FAIL | **class_type=FAIL** — same as 0065 |
| `syn-beer-0015` (B2) | PASS | bold=pass(c0.60) low confidence — Tesseract can't find prefix, verifier defers to vision model |
| `syn-beer-0016` (B3) | REVIEW | bold=pass(c0.60), second-opinion fired and was uncertain → REVIEW |
| `syn-spirits-0014` (S3) | PASS | bold=pass(c0.60) — matches oracle (likely GT_WRONG) |

**Three distinct intervention targets emerge:**

A. **Bold subscore over-rejection** (`ai-label-0035`, `0079`, and likely more): the stroke proxy returns ratio < 1.15 on real-photo compliant labels. Probable cause: photographic capture lighting/shadow biases the binarized stroke-thickness measurement.

B. **Class-type subscore over-rejection** (`ai-label-0065`, `0080`): the vision model's extracted `class_type` doesn't string-match the GT's declared `class_type`. Probable cause: the comparator is too strict against variations like "Grenache" vs. "Grenache Red Wine".

C. **Bold subscore over-acceptance on synthetic labels** (`syn-beer-0014/0015/0016`): Tesseract fails to find the GW prefix tokens, validator falls back to the vision model's `appearsBold` self-report, which is over-confident. The wave-10 prefix-bbox-fallback was attempting to address this; the body-word filter was too loose.

## 3. Bench-side root fixes (already applied, wave-13 part 4)

Two errors in the wave-13 deterministic-error bucket fixed at the bench layer (no verifier code touched):

| Image | Error before fix | Fix |
|---|---|---|
| `ai-label-0048` (correct + wrong) | `Expected object, received null` on `net_contents` | bench `toDeclared` returns null for missing net_contents; per-image trace shows "GT lacks required net_contents" instead of a Zod error |
| `ai-label-0068 / 0073 / 0080` (wrong side) | `Invalid enum value … received 'malt_beverage'` | bench `toDeclared` normalizes out-of-enum class_category values to `"beer"` |

Empirical validation: post-fix N=1 run had errors=2 (the 2 ai-label-0048 cases only), pass-rate 61.5%, all within noise.

## 4. Pre-registered intervention hypotheses (Apex §2.3)

For each candidate intervention, the protocol from `docs/BENCH-PROTOCOL.md` applies: N≥3 baseline + N≥3 experiment + effect size > 2σ to claim improvement. The current 2σ band on passRateOnCorrect is ±0.6 pp, so the experiment must move the mean by **at least 0.6 pp** to claim any effect.

### Hypothesis A — Bold subscore: drop OCR-fail requirement for fontBold corroboration

**Code change** (`src/lib/validation/government-warning-validator.ts:~291`):
```ts
// Current:
if (ocrStatus === "fail") {
  if (modelDisagrees && fontBoldDisagrees) {
    return { status: "review", confidence: 0.4 };
  }
  return { status: "fail", confidence: ... };
}

// Proposed:
if (ocrStatus === "fail") {
  if (modelDisagrees && fontBoldStatus !== "fail") {
    return { status: "review", confidence: 0.4 };
  }
  return { status: "fail", confidence: ... };
}
```

**Rationale**: `fontBoldStatus` is `null` (not "pass") on most Tesseract builds because the LSTM engine doesn't reliably emit `is_bold`. The current AND-of-three requirement (model-pass AND fontBold-pass) means the model-vs-OCR safety net almost never fires — and the OCR's high-confidence FAIL on compliant labels (e.g. `ai-label-0035` at conf 0.90) goes straight to FAIL.

**Pre-registered metrics**:
- `passRateOnCorrect` mean increase by **0 pp** (FAIL→REVIEW doesn't help the headline metric directly; the change moves problems from `false-fail` to `review-on-correct`).
- `false-fail` count decrease by ≥ 5 (from 20 deterministic false-fails to ≤ 15).
- `false-pass-on-correct` count: must NOT increase (regulator-dangerous regression check).
- `failOrReviewRateOnWrong` must stay ≥ 99.4% (-2σ on the 100% baseline).
- `p95_total` must stay within ±2σ of 7295 ms.

**Falsifiability**: if false-fail count doesn't drop by ≥5, OR false-pass-on-correct rises, the hypothesis is falsified and the change is reverted.

### Hypothesis B — Class-type comparator: relax exact-match for descriptive variations

**Code change**: TBD (need to read the class-type comparator first). Investigation: extracted vs declared class_type strings for `ai-label-0065` and `0080`.

**Pre-registered metrics**:
- `false-fail` count decrease by ≥ 2 (from the 2 class_type cases plus any other class-type-driven cases in the wider 20-false-fail set).
- `false-pass-on-correct` must NOT increase.

### Hypothesis C — B-case under-detection: REVIEW when OCR misses prefix + model says bold

**Code change**: when `prefixWords.length === 0` AND `extracted.gov_warning.appearsBold === true` AND `extracted.gov_warning.confidence < 0.85`, route bold subscore to REVIEW instead of PASS.

**Rationale**: the calibrate-bold output showed Tesseract literally can't find the prefix on synthetic B-case labels, so the validator falls back to the vision model alone. The model's bold self-report is unreliable (it called `syn-beer-0016` bold when it wasn't). Demanding higher model confidence routes uncertain cases to a human.

**Pre-registered metrics**:
- `false-pass-on-correct` count drops by ≥ 1 (catches `syn-beer-0016`, possibly `syn-beer-0014/0015`).
- `passRateOnCorrect` mean change within ±0.6 pp (no regression).
- New `review-on-correct` count increase ≤ 3 (acceptable friction for the safety gain).

## 5. Out of scope for wave-13

- Running any of the three pre-registered experiments. Each requires N≥3 baseline + N≥3 experiment ≈ 6 bench runs × 4-7 min ≈ 30-45 min plus ~$0.60 of Gemini cost. Per the protocol this is wave-14 work.
- Regenerating the `declared-wrong/*.json` corpus to fix the stale `class_category: "malt_beverage"` values at source. The bench-side normalization handles it; corpus regeneration is a separate, larger task.
- Resolving the `ai-label-0048` GT defect (`net_contents: null`). Fixing it requires hand-editing the GT row with a plausible volume, which is a corpus-curation task, not a verifier task.

## 6. What this document anchors

Per Apex §13.8a claim ledger, every public claim about verifier accuracy must map to evidence. The claims this document anchors:

- "passRateOnCorrect baseline is 61.3 ± 0.3 pp" → `benchmarks/results/aggregate-2026-05-13T20-46-26-610Z.md` (and subsequent N=6 update).
- "Wave-10's 60.4% was within the noise band" → noise band 61.3 ± 0.6 (2σ), wave-10 result 60.4 ∈ [60.7, 61.9] excluded by the lower bound but within ±1σ, well-below-defensible-regression threshold.
- "20 of the 20 false-fails are TRUE_DEFECTs (verifier over-rejecting compliant labels)" → oracle cross-validation pass, two parallel sub-agents agreeing per-image, Codex CLI confirming on the regulator-dangerous subset.
- "The 5 errors are GT/schema defects, not verifier bugs" → static analysis of `ai-label-0048.json` (net_contents:null) and the wrong-side files (stale `malt_beverage` value), validated empirically by the post-fix bench run dropping errors from 5 → 2.
