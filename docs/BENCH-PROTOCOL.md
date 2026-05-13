# Bench protocol — making scientifically defensible claims

> **TL;DR**: a single cross-pair run is a noisy sample, not a measurement. Any claim about a code change (improvement OR regression) must be backed by N≥3 replicate runs of both the baseline AND the change, with effect size > 2σ of the baseline noise band. Apex framework §13.7 — surface this, do not violate it.

## Why this exists

Before wave-13 the project used a single cross-pair bench run as the headline number for each commit. The "best-known.json" champion ledger picked the single best draw across history. When wave-10 showed a 16-pp drop on its first run, it was reverted as a regression — without checking whether 16 pp was even outside the noise band.

It probably wasn't. The first wave-13 baseline run (commit `9b7e52a`, no code change to the verifier) came in at 61.5%, 15 pp below the 76.5% champion the same code had hit on `d8c6b2d`. Two draws from the same code spanning 15 pp is a strong signal that single-draw comparisons are not measurements — they're samples from a wide distribution.

## What we control vs. what we don't

| Source of variance | Controllable? | How |
|---|---|---|
| Vision model (Gemini) output | No — model is non-deterministic at our temperature | Sample size |
| REVIEW threshold sitting on a confidence boundary | No — same root cause | Sample size; possibly recalibrate threshold |
| Vercel cold-start state | No — function lifecycle | Average over runs that hit warm + cold mix |
| Tesseract WASM warm-up | Partially — `/api/warmup` helps, but first records still pay tax | Discard P95 outliers from first ~3 records |
| Code change being measured | **Yes** | Hold every other variable; flip ONE thing |
| Corpus (170 images) | Yes | Use the same corpus for baseline + change |
| Git commit | Yes | Record commit SHA per run |
| Concurrency setting | Yes | Use same `--concurrency` for all runs |

## The protocol

### Step 1 — Characterise the baseline

For a code change you want to test (call it `experiment-X`):

1. Check out the BASELINE commit (the merge target — usually `main`).
2. Run the bench N≥3 times:
   ```sh
   npx tsx bin/labelverify-bench.ts cross-pair --limit 0 --concurrency 4 --no-track
   ```
   (`--no-track` so champion-ledger updates don't fire during measurement runs.)
3. Aggregate:
   ```sh
   npx tsx bin/bench-aggregate.ts --glob
   ```
   This writes `benchmarks/results/aggregate-<iso>.md` with:
   - `mean ± SD` per headline metric (the noise band)
   - Per-image consistency table: `DETERMINISTIC_FAIL` vs `FLIPPER` vs `DETERMINISTIC_PASS`

### Step 2 — Run the experiment

1. Apply `experiment-X` on a feature branch.
2. Run the bench N≥3 times on the same corpus, same concurrency.
3. Aggregate the new set into its own `aggregate-<iso>.md`.

### Step 3 — Decide

Compare the experiment's `mean` to the baseline's `mean ± 2σ`:

- **|Δmean| ≤ 2σ_baseline** → effect is within noise. Claim NO conclusion. Either gather more samples (cheap if N=3, expensive if N=10), or accept that the change is benign on accuracy and decide on other grounds (latency, cost, complexity).
- **Δmean > 2σ_baseline** (favourable direction) → defensible improvement claim. Update `.best-known.json` with the mean (not the best single draw).
- **Δmean > 2σ_baseline** (adverse direction) → defensible regression claim. Revert or fix.

### Step 4 — Per-image consistency analysis

Independent of the aggregate metrics, look at the consistency table:

- **DETERMINISTIC_FAIL** images are the high-EV bug list. The verifier fails them on every run — fixing them is straight-line accuracy gain.
- **FLIPPER** images are noisy. Do NOT chase individual flippers as bugs; they're samples from a noisy distribution. The right tool is sample size, not bug-fixing.
- **DETERMINISTIC_ERROR** images are GT / schema / perturbation defects. Fix the data, not the verifier.

## Cost note

Each cross-pair run is 340 verifier calls × Gemini cost ≈ $0.10 + ~4-7 min wall time. Budget for N=3 baseline + N=3 experiment = 6 runs, ~$0.60 + ~30 min wall time. This is the table-stakes price for a defensible claim. If a project can't afford to spend $0.60 to validate a code change, it can't afford to make the change.

## What this protocol does NOT defend against

- **Systematic drift in the vision model.** If Gemini's hosted weights change between baseline and experiment runs, the comparison is contaminated. Run baseline + experiment back-to-back on the same day to minimize this.
- **Ground-truth defects.** If the GT itself is wrong, the verifier's "correct" verdicts get scored as wrong. Wave-13 surfaced examples (see `docs/REMAINING-IMPROVEMENTS.md` wave-13 entry). Oracle-validate suspicious cases before treating bench numbers as truth.

## Apex framework anchors

- §2.3 Hypothesis matrix — pre-register the prediction (e.g. "PSM-11 fallback raises passRateOnCorrect mean by ≥ 2 pp").
- §13.7 Noise characterization — N ≥ 3 baseline samples before claiming any effect.
- §13.8a Claim ledger — every public claim about accuracy maps to (file, line, evidence, caveat).
- §12.3 Hypercritical review — when claiming improvement, get a cross-provider sub-agent to verify.

## Why N=3 not N=10

N=3 gives you a reasonable SD estimate (the (N-1) divisor is tight on small samples but workable) and triples the cost. N=10 is the right protocol for a published paper; N=3 is the right protocol for an internal accuracy claim with limited budget. If the effect is real and large, N=3 catches it. If the effect is small (< 2 pp), nothing short of N=20+ catches it reliably, and at that point the question is whether the effect matters operationally.
