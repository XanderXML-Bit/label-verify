# Project Status

> Single-page snapshot of where LabelVerify is. Refreshed when a major
> phase lands. The "live state" reflects what's actually deployed and
> testable right now.

## Live state

| | |
|---|---|
| Deployed | **<https://label-verify-six.vercel.app>** |
| Custom domain | TBD (`zendren.net` or `xandermlopez.com`) |
| Repo | <https://github.com/XanderXML-Bit/label-verify> · `main` branch deploys on push |
| Latest commit | see `git log --oneline -1` |
| Test count | **186/186** across 20 test files |
| `npx tsc --noEmit` | clean |
| `npx next build` | clean |
| CI | green (`bench-routine` against `test-data-v2`, T1 floor 15%) |

## What works end-to-end today

A reviewer can:

1. Open the live URL, drag a label image onto the page.
2. Fill the COLA declared-data form (8 fields).
3. Click **Verify** → receive a per-field PASS / FAIL / REVIEW result in
   under 5 seconds (vision call P50 ~2.2 s on `gemini-2.5-flash-lite`).
4. Or: click one of three pre-populated **Try a sample** affordances
   (PASS / FAIL / REVIEW) and skip the form entirely.
5. Or: upload a folder + paste a CSV manifest → batch verify 200-300
   labels with per-item SSE streaming, filter chips, CSV export.
6. Submit a label via JSON `{url, declared}` API or PDF first-page
   extraction (one-page PDFs only).

The verifier produces an aggregate verdict (`pass | fail | review`) plus
an independent image-quality reading. The Government Warning gets four
subscores (text / caps / bold / size) with the worst-status aggregation
rule. Per-field confidence below 0.75 downgrades PASS → REVIEW
automatically (never downgrades FAIL → REVIEW — strict regulatory
non-compliance is still a hard fail).

## What's intentionally left for the user / Codex

| Block | Status | Why blocking |
|-------|--------|--------------|
| Custom domain | TBD | Needs user DNS + Vercel domain assignment |
| Real-TTB-corpus images | Codex in flight (`test-data/ai-generated/` partially populated) | OOD column stays empty until they land |
| Full bake-off run | Not run yet | Costs ~$1 in API calls; user-gated decision |
| Loom walkthrough video | TBD | Needs user-authored walkthrough |

## What's done since the last status

- **17 extractor candidates** registered (T1 baseline + T4/T4b/T5b/T6/T6b/T6c/C1 direct-SDK + T6d/T6e/T7/T7b/T8/T9/T10/T11/T12 via OpenRouter). `npm run bench:bakeoff` runs them all.
- **OpenRouter adapter** unlocks frontier models (Gemini 3.x, GPT-5, GPT-OSS-120B, Nemotron, Pixtral, Llama 3.x, Claude Opus 1M) via a single SDK path.
- **Confidence-first deferral** — `REVIEW_CONFIDENCE_THRESHOLD = 0.75` in `verify.ts` downgrades borderline PASS to REVIEW; `/api/queue` (gated by `DEBUG_TOKEN`) exposes the queue; `ReviewQueuePanel` renders the count on the home screen.
- **Routine sub-corpus** — 15 curated labels in `benchmarks/routine.ts` + `test-data-v2/routine-manifest.json`. `npm run bench:routine` for fast / cheap CI; `npm run bench:bakeoff` for the formal selection run. Mutually exclusive with `--smoke`.
- **Economics + Pareto frontier** in bench output — token counts, $/call, $/1k labels, accuracy/$, accuracy/sec, plus a non-dominated-techniques table.
- **OCR-bbox bold detection v2** — per-column mean-stroke-thickness metric, recalibrated thresholds (compliant ≥ 1.5, fail ≤ 1.15). Catches B1 false-pass.
- **PDF input** + **URL input** with SSRF guards + **rate limiter** + **`/api/debug/last`** trace endpoint (gated by `DEBUG_TOKEN`).
- **GitHub Actions CI** — typecheck + lint + tests + build + `bench-routine` regression guard.
- **`vercel.json`** — `iad1` region, per-route memory + maxDuration, security headers.
- **CONFIRM: live deploy at <https://label-verify-six.vercel.app>**.

## What I'm watching

- **Codex final corpus drop** — the v2 synthetic corpus is good enough
  for the bake-off, but if Codex's images are more realistic we should
  re-run against those.
- **B1 detection on real images** — the new OCR stroke-width metric
  works on synthetic; once Codex's images land we'll see if the metric
  generalizes or needs another pass.
- **OpenRouter pricing drift** — some prices in `techniques.ts` are
  marked `TODO: confirm vs OpenRouter`. If the bake-off becomes a real
  cost comparison, those should be verified against the live catalog.

## Pre-registered decision criteria

From [`docs/MODEL-SELECTION.md`](MODEL-SELECTION.md) §3, in priority order:

1. Government-Warning FN rate ≤ 10 %.
2. Overall accuracy CI lower bound ≥ 85 %.
3. P95 latency ≤ 6 s.
4. Cost / 1k labels ≤ $1.00 OR McNemar p < 0.01 vs. the cheaper option.
5. Cross-provider preference for resilience.

The bake-off settles the choice; §4 fills in afterwards.

## How to run the bake-off (when ready)

```bash
# Fast / cheap glance against the routine subset:
npm run bench:routine:bakeoff -- --corpus test-data-v2

# Full formal decision run (all 17 candidates × all v2 × 3 trials):
npm run bench:bakeoff -- --corpus test-data-v2
```

The result lands in `benchmarks/results/<iso-timestamp>.{json,md}`.
Copy the winner row into `MODEL-SELECTION.md` §4.

## Anything new for the user to know

- **Live URL works.** Try [/](https://label-verify-six.vercel.app),
  click "Try a sample" → see end-to-end result.
- **Review queue is now first-class.** The verifier won't return PASS on
  a borderline case; it routes to the queue. With `DEBUG_TOKEN` set, the
  queue is reachable via `/api/queue` and rendered on the home page.
- **17 model candidates** are ready to bake off — way more than the
  user asked about, with the long-tail accessible via OpenRouter.
