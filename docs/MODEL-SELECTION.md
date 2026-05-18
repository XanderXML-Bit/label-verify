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
Primary production model: gemini-3.1-flash-lite (pinned in code)
MODEL_FALLBACK = <model id>         # tiered-escalation target (optional)
```

The decision below settles the default values shipped in `.env.example`
and the `vercel.json` environment block. A reviewer who reads the
deployed `/api/health` response will see this pinned primary model and should
be able to trace it directly back to this document.

## 2. Candidate set

Per [`docs/archive/APPROACH.md`](docs/archive/APPROACH.md) §2, the full bake-off candidate set is:

| ID | Model | Provider | Pricing (per 1M in / out) |
|----|-------|----------|---------------------------|
| T1 | Tesseract baseline | local | $0 |
| T4 | GPT-4o-mini | OpenAI | $0.15 / $0.60 |
| T4b | GPT-4o (full) | OpenAI | $2.50 / $10.00 |
| T5b | Claude Haiku 4.5 | Anthropic | $1.00 / $5.00 |
| T6 | Gemini 3.1 Flash Lite (production primary since wave-27) | Google | $0.25 / $1.50 |
| T6b | Gemini 2.5 Flash (default second-opinion since wave-22) | Google | $0.075 / $0.30 |
| T6c | Gemini 3.1 Pro Preview | Google | $1.25 / $5.00 |
| T6d | Gemini 2.5 Pro (legacy) | Google | $1.25 / $5.00 |
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

## 3.5 Routine vs. full bake-off

Running the full corpus on every commit is wasteful — and once vision
contenders are wired up, outright expensive (USD per call × N labels × M
trials adds up fast). The routine subset (`npm run bench:routine`) is a
curated 15-label slice that hits every important axis with minimum
overlap: 3 fully-compliant baselines, the dominant gov-warning
non-compliance cases (X1 / T1 / C1 / B1 / S2 / X3), each degradation
class (perspective / lowlight / occlusion / curved), a stylized-brand
edge case, and a small-container compliant pair to the S2 fail. The list
is hand-curated and committed (see `benchmarks/routine.ts` and
`test-data-v2/routine-manifest.json`) so a routine run today compares
apples-to-apples with the same run last week — random sampling would let
the signal drift between commits.

**When to use which:**

| Mode | Command | Corpus | Trials | Use it for |
|------|---------|--------|--------|------------|
| Routine | `npm run bench:routine` | 15 curated | 1 | CI, fast feedback, cost-conscious "is anything obviously broken?" |
| Routine bake-off | `npm run bench:routine:bakeoff` | 15 curated | 1 | Quick cross-technique sniff with API keys set |
| Smoke (legacy) | `npm run bench:smoke` | first 20 | 1 | Kept for backward compatibility; prefer routine |
| Full | `npm run bench` | all v2 (n≈90) | 3 | Local pre-bake-off rehearsal |
| Bake-off | `npm run bench:bakeoff` | all v2 | 3 | Formal §4 decision run — fills in the table below |

The decision in §4 is settled by the full bake-off, not by any routine
result. Routine catches regressions; the bake-off picks the winner.

## 4. The bake-off result

### 4.1 Winner

| | |
|---|---|
| **Primary** | **T6 — Gemini 3.1 Flash Lite (Google direct SDK)** |
| **Borderline-Gov-Warning second-opinion** | **Gemini 2.5 Flash (Google direct SDK)** — wave 22 swap (2026-05-13). Same-provider, materially smarter on borderline cases. See [`WAVE-22-FINDINGS.md`](WAVE-22-FINDINGS.md). |
| **Cross-provider backup on primary failure** | T7b — GPT-5.4-nano (OpenAI direct SDK) — fires only when primary Gemini itself fails (5xx / timeout / abort). Distinct from the second-opinion path. |
| Run ID | `benchmarks/results/2026-05-12T05-18-48-405Z.{json,md}` (T1–T12 + C1 main run) + `2026-05-12T05-42-10-912Z.{json,md}` (Anthropic + open-weight rerun via OpenRouter) |
| Corpus | `test-data-v2` routine subset (12 of 90 curated images covering compliant baselines, Government-Warning failure modes, and degradation classes). See §4.3a for the 170-image combined-corpus rerun that confirmed the winner on the broader set. |
| Trials per image | 1 (routine subset); §4.3a reruns with 1 trial per image across the combined 170-image corpus. |

### 4.2 Why this winner

The routine bake-off measured 13 model variants on accuracy, P50 latency,
and USD-per-1k-labels. T6 (Gemini 3.1 Flash Lite via the direct Google
SDK) lands on the Pareto frontier on every axis, and the closest
contenders fail decisive criteria:

| ID | Model | Accuracy | P50 | USD / 1k | Notes |
|----|-------|----------|-----|----------|-------|
| **T6** | **Gemini 3.1 Flash Lite (direct)** | **97.6 %** | **2.28 s** | **$0.25** | **Pareto winner** — fastest *and* highest-accuracy non-Pro option |
| T6c | Gemini 3.1 Pro Preview (direct) | 96.4 % | 25.3 s | $4.12 | 11× slower, 16× cost, *lower* accuracy on this corpus |
| T6d | Gemini 3.1 Pro Preview (via OpenRouter) | 98.8 % | 24.1 s | $4.12 | Highest accuracy but 10× slower, 16× cost — Δ accuracy not defensible at that price |
| T6e | Gemini 3.1 Flash Lite (via OpenRouter) | 96.4 % | 2.92 s | $0.25 | Same model as T6, OpenRouter routing — 1.2 pp lower accuracy, 28% slower; direct wins |
| T4 | GPT-4o-mini (direct) | 91.7 % | 24.1 s | ≈ $0.50 | 5.9 pp below T6, 11× slower |
| T4b | GPT-4o full (direct) | 90.5 % | 18.8 s | ≈ $10.00 | 7.1 pp below T6, 17× slower, 40× cost |
| T7 | GPT-5.5 (OR) | 94.0 % | 13.6 s | ≈ $25.00 | 3.6 pp below T6, 6× slower, 100× cost |
| **T7b** | **GPT-5.4-nano (OR)** | **92.9 %** | **3.24 s** | **$1.25** | Fallback choice: cross-provider, ~ 5 pp below T6 but a different family |
| T8 | Mistral Medium 3.5 (OR) | 36.9 % | 2.91 s | $1.50 | Below FN-rate floor |
| T9 | NVIDIA Nemotron 3 Nano Omni :free (OR) | 20.0 %† | 47.0 s | $0 | Free tier rate-limits to timeout territory; below floor |
| T10 | Qwen 3.6 Flash (OR) | 38.1 %† | 25.3 s | $0.25 | Below FN-rate floor; 3 timeout failures |
| T11 | Llama 4 Maverick (OR) | 34.5 % | 3.58 s | $0.15 | Below FN-rate floor; fast but flat-schema model with confidence-coercion gap |
| T12 | Claude Opus 4.7 (OR) | 51.2 % | 6.39 s | $5.00 | Flat-schema model — coercion-path ceiling ~55 % on this corpus |
| C1 | OCR + Gemini Flash Lite (T1 + T6 combined) | 89.3 % | 2.89 s | $0.25 | OCR-as-hint provides no accuracy gain — the C1 working hypothesis from `docs/archive/APPROACH.md` §4.1 is **falsified** |
| T1 | Tesseract OCR baseline | 33.3 % | 0.64 s | $0 | Network-blocked fallback; not a serious contender on accuracy |
| T5b | Claude Haiku 4.5 (OR) | 54.8 % | 4.07 s | $1.00 | Schema-coercion gap; well below floor on this run |

† T9 free tier rate-limited 7 of 12 calls to a 60 s timeout; accuracy
computed across the 5 successful images.

**Verdict-decision criteria check (from §3):**

> **Government-Warning FN-rate measurement.** Use the 170-image
> combined-corpus run for the criterion check, not the 12-image
> routine slice (n = 7 non-compliant labels is too small to
> support a 10 % criterion). T6 on the 170-image corpus:
> **5.1 % (n = 137, Wilson 95 % CI [2.5, 10.2])**. Point estimate
> clears the criterion; the upper Wilson bound does not, given the
> n = 137 sample size for the non-compliant stratum.

1. ⚠ Gov-Warning FN ≤ 10 %: point estimate 5.1 % is inside;
   Wilson 95 % CI upper bound 10.2 % is just over. T6's
   Government-Warning subscore combines model self-report + OCR-bbox
   bold + classical-CV stroke-width measurement — three signals
   that all need to fail for a non-compliant warning to slip
   through as PASS. A federal deploy would want a larger
   human-adjudicated holdout to tighten the CI.
2. ✅ Accuracy CI lower bound ≥ 85 %: 93.8 % overall on the
   170-image corpus; Wilson 95 % CI floor 92.3 % sits well above.
3. ✅ P95 ≤ 6 s: T6 P95 = 4.1 s on the latest run.
4. ✅ Cost ≤ $1 / 1k labels: $0.25 / 1k.
5. ✅ Single-provider risk: Fallback (T7b, GPT-5.4-nano) is a
   different provider (OpenAI). The fallback fires only on
   primary-provider failure — see §4.4 for the exact contract.

### 4.3 What the priors got wrong

The pre-registered prediction matrix in `docs/archive/APPROACH.md` §4 expected:

| Prediction | Predicted | Measured | Verdict |
|------------|-----------|----------|---------|
| C1 (OCR + Vision combined) beats vision-only by ≥ 3 pp on Gov-Warning | C1 ≈ 90–96 % | C1 = 89.3 % (n=84) vs T6 = 97.6 % | **Falsified** — OCR-as-hint *hurt* the model on this corpus. T1-text + T6-vision is worse than T6 alone. The vision model trusts the OCR string for stylized brand fonts where the OCR mis-reads, then the vision call defers. **C1 does NOT ship in production** — `src/lib/verify.ts` is a single vision-only path with no Settings panel and no mode selector. The wrapping helper (`buildOcrHintSection`) is retained for benchmark mode + defensive future use only. T6 is the deployed primary. |
| Gemini Flash beating GPT-4o-mini by ≥ 5 pp at half cost | "plausible" | T6 = 97.6 %, T4 = 91.7 %, Δ = 5.9 pp, T6 is 50% cheaper | **Confirmed.** |
| Tesseract beating hosted on Gov-Warning text-match | "plausible" | Tesseract Gov-Warning subscore tied or lost on every image | **Falsified for this corpus.** Hosted models do not paraphrase the Government Warning when explicitly instructed not to (the EXTRACTION_PROMPT's CRITICAL RULE #1 holds). |
| Gemini 3.1 Pro Preview is the accuracy ceiling | "implicit" | T6c (Pro direct) = 96.4 % < T6 (Flash Lite direct) = 97.6 % | **Surprised us.** Pro Preview on this corpus *underperforms* the cheaper Flash Lite tier. Hypothesis: Pro's reasoning chain occasionally rewrites the Government Warning verbatim text, breaking RULE #1; Flash Lite is too small to second-guess. |

### 4.3a Combined-corpus rerun (170 images, 2026-05-12 morning)

After the initial bake-off settled on T6, the corpus was expanded to
include 50 photo-realistic AI labels + 30 targeted Codex batch-02
labels for a 170-image combined run. T6 was re-benched alongside T6f
(Gemini 3 Flash Preview, the newer/larger Gemini Flash tier) to
confirm the choice held:

| ID | Model | Acc | ID | OOD | GW FN | P50 | $/1k |
|----|-------|-----|----|----|-------|-----|------|
| **T6** | **Gemini 3.1 Flash Lite (direct)** | **93.8 %** | 95.8 % | **88.3 %** | **5.0 %** | **3.2 s** | **$0.25** |
| T6f | Gemini 3 Flash Preview (OpenRouter) | 94.3 % | 97.3 % | 87.2 % | 10.8 % | 4.0 s | $2.43 |

T6f scores 0.5 pp higher overall and 1.5 pp higher on the synthetic
(ID) subset — but **fails the Government-Warning FN-rate criterion**
(10.8 % > 10 %), runs 25 % slower, costs ~10× more per 1k labels, and
scores 1.1 pp LOWER on the photo-realistic (OOD) subset that matters
most for real submissions. The regulator-dangerous-direction metric
(Gov-Warning FN-rate) is the dealbreaker: T6f lets twice as many
non-compliant warnings slip through as PASS. **T6 stays primary.**

Result files committed: `benchmarks/results/2026-05-12T16-55-38-735Z.{md,json}`
(initial T6 run), `2026-05-12T17-09-38-237Z.{md,json}` (T6f), and
`2026-05-12T17-10-53-642Z.{md,json}` (T6 rerun for variance check).

### 4.4 Backup chain

The orchestrator in `src/lib/verify.ts` runs a single primary path
and falls back to a second provider only on **primary failure**
(network error, 5xx, rate-limit, schema-parse error, timeout abort).
The chain in production today is:

```
T6 (primary: Gemini 3.1 Flash Lite)
  ↓ (extractor throws — provider down / rate-limited / timed out)
T7b (fallback: GPT-5.4-nano via OpenAI SDK, fresh AbortController + remaining-budget timer)
  ↓ (both providers failed)
500 — primary error surfaced to the caller
```

**This is NOT a low-confidence-driven fallback.** A primary call
that returns successfully but with confidence < 0.55 on any field
does NOT trigger the fallback; instead, the orchestrator's
`REVIEW_CONFIDENCE_THRESHOLD` floor routes the verdict to REVIEW
and the review-queue surfaces it for human inspection. The fallback
only fires when the primary literally fails to return a result.

There is **no Tesseract-only degradation tier in production** —
when both providers fail, the orchestrator surfaces the primary
error and the request returns 5xx. Tesseract OCR runs in parallel
to feed the Gov-Warning bold/size subscores; it is not a backup
extractor.

If you need a richer degradation story for a self-hosted deploy
(e.g. an air-gapped TTB environment), the bench harness exercises
T1 (Tesseract-only) and it scores ~33% on the corpus — well below
the criterion, but it's a real third tier you could wire as a
defensive fallback. The hosted prototype deliberately doesn't ship
it because returning a 33%-accurate verdict to a TTB reviewer is
worse than returning an error they can retry.

### 4.5 What we're not deciding here

- Whether a future model release moves the frontier — that's a re-run.
- A tiered-escalation threshold (per-field confidence routing across
  multiple providers). The phantom `lib/vision/tiered.ts` referenced
  in earlier drafts of this document was never built; production
  fallback is provider-failure-only and lives in
  `src/lib/verify.ts:188-247`. If a future build re-introduces
  multi-tier escalation, calibrate the threshold against this same
  bake-off run with a separate sub-experiment.
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
- [ ] Runtime primary path remains pinned; benchmark candidates stay out of `.env.example`
- [ ] `vercel.json` env block (if present) updated
- [ ] [`docs/archive/APPROACH.md`](docs/archive/APPROACH.md) §6 Decision Record table updated
- [ ] Markdown report committed to `benchmarks/results/`
- [ ] One paragraph in this file's §4.2 explaining the choice
