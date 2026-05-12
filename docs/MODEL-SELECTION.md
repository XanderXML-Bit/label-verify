# Model Selection — Decision Record

> The benchmark harness (`benchmarks/run.ts`) compares extractor techniques
> against the labeled corpus on **accuracy**, **latency**, and **cost**.
> This document is the place where that comparison turns into a *decision*:
> the model deployed to production, justified by the numbers.
>
> Filled in **after** the bake-off run lands. Until then this file is a
> template — every "TBD" gets a real value, not a guess.

## 1. What we're choosing

The deployed extractor in `verify.ts` is selected at runtime via env vars:

```
MODEL_PRIMARY = <model id>          # the workhorse
MODEL_FALLBACK = <model id>         # tiered-escalation target (optional)
```

The decision below settles the default values shipped in `.env.example`
and the `vercel.json` environment block. A reviewer who reads the
deployed `/api/health` response will see this `MODEL_PRIMARY` and should
be able to trace it directly back to this document.

## 2. Candidate set

Per [`APPROACH.md`](APPROACH.md) §2, the full bake-off candidate set is:

| ID | Model | Provider | Pricing (per 1M in / out) |
|----|-------|----------|---------------------------|
| T1 | Tesseract baseline | local | $0 |
| T4 | GPT-4o-mini | OpenAI | $0.15 / $0.60 |
| T4b | GPT-4o (full) | OpenAI | $2.50 / $10.00 |
| T5b | Claude Haiku 4.5 | Anthropic | $1.00 / $5.00 |
| T6 | Gemini 2.0 Flash | Google | $0.075 / $0.30 |
| T6b | Gemini 2.5 Flash | Google | $0.075 / $0.30 |
| T6c | Gemini 2.5 Pro | Google | $1.25 / $5.00 |
| C1 | OCR + Vision (Gemini Flash) | local + Google | ≈ T6 |

Run them all with:

```bash
npm run bench:bakeoff -- --corpus test-data-v2
# or, faster smoke (20 images, 1 trial):
npm run bench:bakeoff:smoke -- --corpus test-data-v2
```

The output writes to `benchmarks/results/<iso-timestamp>.{json,md}` and
the markdown contains:

- Overall accuracy + Wilson 95 % CI per technique
- Latency P50 / P95 per technique
- Token & USD economics (per call, per 1k labels, accuracy-per-dollar,
  accuracy-per-second)
- **Pareto frontier** (techniques not strictly dominated on
  accuracy ↑ / latency ↓ / cost ↓)
- McNemar pairwise tests for "is A really better than B"
- Government-Warning false-negative rate per technique (the regulator-
  dangerous direction)
- OOD (real-label) column reported separately

## 3. Decision criteria (pre-registered)

Order of priority — the higher row wins ties:

1. **Government-Warning FN rate must be ≤ 10 %.** Passing a non-compliant
   label is the worst kind of error a regulator can ship.
2. **Overall accuracy CI lower bound ≥ 85 %.**
3. **P95 latency ≤ 6 s** (the architecture is willing to spend 5 s wall
   clock; one second of headroom for the tail).
4. **Cost / 1k labels ≤ $1.00** unless the accuracy delta over the
   cheaper option is statistically significant (McNemar p < 0.01).
5. **Single-provider risk:** if two techniques tie on the criteria above,
   prefer the one whose provider is *different* from the fallback's
   provider — for resilience.

If no technique satisfies (1) we declare the prototype *not yet
production-ready* and document what would have to improve.

## 4. The bake-off result (fill in after run)

Replace the placeholders below with the actual numbers from the run.
Keep the prose short — the markdown report has all the detail.

### 4.1 Winner

| | |
|---|---|
| Primary | **TBD** (e.g. T6b Gemini 2.5 Flash) |
| Fallback (tiered) | **TBD** (e.g. T4b GPT-4o full, only on low-confidence escalation) |
| Run ID | TBD (`<iso-timestamp>.json`) |
| Corpus | TBD (`test-data` v1, `test-data-v2`, or the Codex final set) |
| Trials per image | TBD |

### 4.2 Why this winner

One paragraph naming the criterion each loser failed:

> e.g. *"T6b won on the Pareto frontier with 92.1 % accuracy [88.4, 94.8] at
> $0.18/1k and 2.1 s P50. T6c (Pro) hit 93.0 % but at 17× the cost and 1.4 s
> slower P95 — McNemar p = 0.12 against T6b, so the accuracy delta is not
> defensible at that price. T4b (GPT-4o full) was the only candidate dominated
> on every axis. T1 hit the FN-rate floor as expected — kept as the
> network-blocked degradation path, not the deployed primary."*

### 4.3 What the priors got wrong

The pre-registered prediction matrix in `APPROACH.md` §4 had numbers we
expected to see. After the run:

- **Wrong by ≥ 5 pp:** TBD
- **Wrong on direction:** TBD
- **Right on direction, off on magnitude:** TBD

We are explicit about this so a reviewer can see we follow the data.

### 4.4 What we're not deciding here

- Whether a future model release moves the frontier — that's a re-run.
- The fallback tiered-escalation threshold (lives in
  `lib/vision/tiered.ts`); calibrate it against the same bake-off run
  with a separate sub-experiment.
- Per-field model assignment ("Gemini for brand, Claude for warning
  text") — out of scope for v1; would require a multi-model orchestrator
  and a much larger corpus to justify.

## 5. How to re-run after a model release

Six months from now, providers will have shipped new tiers. To re-run:

```bash
# 1. Bump model IDs in src/lib/vision/{gemini,openai,anthropic}.ts
# 2. Update pricing if it changed
# 3. Re-run the bake-off
npm run bench:bakeoff
# 4. Read the new markdown, update this document's §4 in place
# 5. Commit with a clear message: "Model selection: <old> → <new>, run <id>"
```

The bake-off itself takes about 10 minutes of API time on the full
corpus (4-technique fan-out × 90 images × 3 trials ≈ 1,000 calls). On
smoke mode it's about 90 seconds.

## 6. Sanity-check checklist before you commit a new winner

- [ ] FN-rate criterion (3.1) met
- [ ] Accuracy CI lower bound criterion (3.2) met
- [ ] P95 latency criterion (3.3) met
- [ ] Cost criterion (3.4) met OR accuracy delta defensible (McNemar
      p < 0.01)
- [ ] Pareto frontier table actually includes the winner
- [ ] `.env.example` updated with the new `MODEL_PRIMARY`
- [ ] `vercel.json` env block (if present) updated
- [ ] [`APPROACH.md`](APPROACH.md) §6 Decision Record table updated
- [ ] Markdown report committed to `benchmarks/results/`
- [ ] One paragraph in this file's §4.2 explaining the choice
