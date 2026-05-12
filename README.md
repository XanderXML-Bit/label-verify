# Label Verify

[![CI](https://github.com/XanderXML-Bit/label-verify/actions/workflows/ci.yml/badge.svg?branch=main)](https://github.com/XanderXML-Bit/label-verify/actions/workflows/ci.yml)

AI-powered verification of beverage-label artwork against COLA
application data. Prototype for the U.S. Department of the Treasury,
Alcohol and Tobacco Tax and Trade Bureau (TTB).

**Live demo:** <https://label-verify-six.vercel.app>
**Repo:** <https://github.com/XanderXML-Bit/label-verify>

---

## What it is

A reviewer drops a label image plus the COLA application data and gets
a structured **pass / fail / review** verdict on each of the seven
regulated fields — brand, class/type, ABV, net contents, producer,
country of origin, and the Government Warning statement under 27 CFR
§16.21 / §16.22 (text, all-caps prefix, bold prefix, type size).

The brief target was ≤ 5 s per label, beating the prior vendor's
30–40 s. The deployed primary path runs in **2.4 s P50**, **3.3 s P95**
on Gemini 3.1 Flash Lite at **$0.25 per 1,000 labels**.

## Headline measurement — combined-corpus bake-off (2026-05-12)

Field-level accuracy on a **140-image combined corpus**:
**90 SVG-rendered synthetic** labels (`test-data-v2/`) +
**50 photo-realistic** labels rendered by Codex
(`test-data/ai-generated/`). 973 field measurements (140 × 7 fields,
minus one image that the extractor failed to parse). Wilson 95 % CIs.

| Subset | n | Accuracy | 95 % CI |
|---|---|---|---|
| **All** (combined) | 973 | **93.3 %** | [91.6, 94.7] |
| ID — synthetic SVG | 630 | 96.0 % | [94.2, 97.3] |
| OOD — photo-realistic | 343 | 88.3 % | [84.5, 91.3] |
| Government Warning false-negative rate | 109 | 6.4 % | [3.1, 12.7] |

**Honest framing.** Synthetic SVG is the easy case (rendered text the
model OCRs cleanly). The photo-realistic OOD subset is closer to real
TTB submissions and gives the more conservative 88 % accuracy. The
6.4 % Gov-Warning FN-rate is the regulator-dangerous direction (a
non-compliant warning slipping through as PASS); it's well inside the
pre-registered ≤ 10 % criterion. Source result file:
`benchmarks/results/2026-05-12T08-14-50-786Z.md`.

This is the **bare-extractor** number — what the model alone gets
right. The orchestrator above the extractor adds:
- **Confidence-based deferral** — borderline PASS verdicts route to a
  human-review queue rather than ship a wrong-but-confident answer.
- **Producer-country inference** — labels that print "Portland, ME"
  without an explicit "USA" no longer mismatch the country field
  (added 2026-05-12; fixed a class of false-REVIEWs on US labels).
- **Auto-fallback** — if Gemini is unreachable, the request retries
  once against GPT-5.4-nano (OpenAI) before failing, with a yellow
  "verified via backup" banner on the result.

## How to use it

Open the live URL and choose one of three flows:

1. **Image + manual form** — drop a label image, fill the seven
   declared fields, click Verify. Standard COLA-style flow.
2. **Image + application file** — drop a label image, then upload the
   COLA application as PDF / JSON / CSV / Markdown / plain text / a
   photo of the form. The parser prefills the editable form; you
   confirm or edit; then Verify.
3. **Image-only "extract without verdict"** — for when you don't have
   the application data. Shows extracted fields and the Gov Warning
   subscore (federal regulation, independent of application data) but
   does NOT render a PASS / FAIL / REVIEW chip — a yellow banner
   makes the "not a verification" status unmissable.

Batch mode accepts up to **1,000 labels** with a CSV/JSON manifest;
results stream back over SSE with a virtualised table and CSV export.

## Architecture at a glance

```mermaid
flowchart LR
  U[Reviewer browser] -- image + declared --> UI[Next.js UI]
  UI -- POST /api/verify --> V[Verify orchestrator]
  V --> P[sharp preprocess]
  P --> O[Tesseract OCR]
  P --> X[Vision extractor]
  O -. OCR text if returns first .-> X
  X --> M[Field matchers]
  O --> M
  M --> G[Gov Warning validator<br/>27 CFR §16.21 + §16.22<br/>+ classical-CV stroke-width bold]
  G --> A[Aggregate verdict + image quality]
  A --> UI
  V -. on Gemini failure .-> F[Fallback: GPT-5.4-nano]
  F --> M
```

Latency budget is honest: vision call dominates (~2 s P50), preprocess
+ OCR run in parallel, matchers + validators are sub-100ms. The
Government Warning's bold-prefix check uses pixel-level stroke-width
measurement on the OCR-located prefix bbox (classical CV — see
[`src/lib/validation/bold-size.ts`](src/lib/validation/bold-size.ts));
this is one place where measurement is genuinely better than asking an
LLM "is this bold."

## Methods considered

Full decision trail in
[`docs/ALTERNATIVES.md`](docs/ALTERNATIVES.md). Short version:

| Method | Realistic ceiling | Verdict |
|---|---|---|
| Classical CV / template matching | 60–75 % on imperfect photos | Brittle to R4 (angles/glare/occlusion) |
| Pure OCR + regex/rules (Tesseract / PaddleOCR) | 75–85 % (text only) | No semantic field assignment; measured 33 % on our corpus |
| Self-hosted open-weight VLMs (Qwen2.5-VL, Llama 4 Vision) | ~95 % ceiling, +GPU ops | Right choice for data-residency; wrong scope for take-home |
| Specialised Document AI (Textract, Google DocAI) | 98 % on clean forms | Out-of-paradigm — labels are graphic design |
| Custom CNN trained on TTB labels | Could approach 99 % with data | Need ~10 k labelled labels we don't have |
| Hybrid (YOLO + PaddleOCR + small classifier + LLM glue) | High ceiling, ~2 weeks engineering | Production choice; wrong for a 7-day prototype |
| **Hosted LLM vision (Gemini 3.1 Flash Lite)** | **96.0 % ID / 88.3 % OOD measured** | **Chosen — Pareto-dominant on accuracy/latency/cost** |

The brief explicitly permits cloud APIs (§8 Latitude: "free choice of
model provider"). §10 asks for graceful degradation when the hosted
model is unreachable — which we have, via the GPT-5.4-nano fallback
plus a Tesseract-only floor.

## Models benchmarked

`npm run bench:bakeoff` ran a 13-variant tournament covering OpenAI
(GPT-4o-mini, GPT-4o, GPT-5.5, GPT-5.4-nano), Google (Gemini 3.1 Flash
Lite, Gemini 2.5 Flash, Gemini 3.1 Pro × 2 routing paths), Anthropic
(Claude Haiku 4.5, Claude Opus 4.7), Meta (Llama 4 Maverick), Mistral
(Medium 3.5), NVIDIA (Nemotron 3 Nano Omni), Alibaba (Qwen 3.6 Flash),
plus Tesseract baseline (T1) and an OCR+vision combination (C1). Full
table and the criterion-by-criterion winner justification in
[`docs/MODEL-SELECTION.md`](docs/MODEL-SELECTION.md) §4.

Why Gemini 3.1 Flash Lite won: 97.6 % on the routine 12-image
subset → 93.3 % on the combined 140 corpus, 2.4 s P50, $0.25 per 1 k
labels. The Pro Preview tier scored marginally higher (98.8 %) but at
10× cost and 10× latency — Pareto-dominated for our 5-s budget. GPT-5.4
nano sits as the fallback at 92.9 % / 3.2 s / $1.25 per 1 k — a
different provider in case Google is unreachable, and only ~5 pp
behind primary. The C1 hypothesis (OCR-as-hint improves vision) was
**falsified** — OCR text fed into the vision prompt actually hurt
accuracy on this corpus, because the model defers to OCR errors on
stylised fonts. We ship vision-only.

## Procedure

The decisions in
[`MODEL-SELECTION.md`](docs/MODEL-SELECTION.md) §4 and
[`APPROACH.md`](docs/APPROACH.md) §4 are pre-registered — predictions
written before measurements so we can show priors-vs-reality. After
the run, [`MODEL-SELECTION.md`](docs/MODEL-SELECTION.md) §4.3 records
what we got wrong (the C1 hypothesis was the biggest miss). McNemar
pairwise tests, Wilson 95 % CIs, OOD stratification all reported
honestly. The bench harness writes to
`benchmarks/results/<iso-timestamp>.{json,md}` so a future re-run is
reproducible: same script, same corpus, comparable numbers.

## Validation methodology

- **Corpus.** 140 images. The 90 v2 labels are SVG-rendered from
  deterministic templates with hand-controlled
  Government-Warning failure modes (see
  [`docs/government-warning-cases.md`](docs/government-warning-cases.md)
  for the taxonomy). The 50 photo-realistic labels were rendered by
  Codex's built-in image-gen tool, then visually audited by a
  4-sub-agent chunked review (see `test-data/ai-generated/manifest.json`).
- **Ground truth.** Each image has a JSON ground-truth file with all
  seven declared fields plus Gov-Warning subscore truths. Adjudication
  was the prompt-declared field set for synthetic; visual audit for
  AI-generated. The AI ground-truth was cross-validated by an
  independent Gemini 3.1 Pro Preview oracle pass on all 50 images
  (`.review/ai-corpus-cross-validation.md`) — drift on
  `country_of_origin` (Codex over-claims "USA" when no country marking
  is visibly present) was corrected during conversion to the v2
  schema.
- **Scoring.** Per-field PASS/FAIL via `compareBrand`,
  `compareClass`, `compareAbv`, `compareNetContents`,
  `compareProducer`, `compareCountry`, plus the four Gov-Warning
  subscores (text exact match / all-caps / bold via SWT / size
  threshold). Aggregated by worst-of rule.
- **Stats.** Wilson 95 % CI per technique × stratum. McNemar pairwise
  tests between candidate techniques.

## Beyond the brief

- **Application-input parser** — PDF text extraction (pdfjs-dist),
  CSV/JSON parsing, Markdown / plain-text regex extraction, photo of
  the application form via vision. Three input modes (manual / file /
  image-only) instead of just one.
- **Sample affordance** — three pre-populated examples (PASS / FAIL /
  REVIEW) so a reviewer sees an end-to-end result on first click. Now
  uses AI-photographed labels, not SVG; the prior SVG samples were
  best-case behaviour.
- **Confidence-based deferral** — borderline PASS verdicts auto-route
  to a human-review queue instead of shipping low-confidence
  approvals. Threshold `REVIEW_CONFIDENCE_THRESHOLD = 0.55` calibrated
  against the bake-off; documented in `verify.ts`.
- **Live elapsed timer + progress bar** during verify (instead of
  an indefinite pulse), with a soft "still working" message past
  10 s.
- **API status banner** — on page load, hits `/api/health` and warns
  the reviewer if a provider key is missing in the deployment env
  before they spend time filling the form.
- **Auto-fallback** — Gemini failure → GPT-5.4-nano with a clear
  banner on the result so the reviewer can't miss it.
- **Dark mode** — pre-paint inline script prevents FOUC; toggle
  persists in localStorage; full Tailwind dark-mode coverage tuned
  for AA contrast on both white and slate-900 panels.
- **Mobile-responsive** — 44 px touch targets, layout collapse under
  480 px, font-size policy in `globals.css`.

## Security posture

Mitigations applied (full audit trail in commit messages, last review
2026-05-12):

- SSRF guard on URL fetch — rejects RFC1918 + loopback + link-local +
  CGNAT + 255.255.255.255 multicast, AND non-canonical IPv4 literal
  forms (decimal `2130706433`, hex `0x7f000001`, octal
  `017700000001`). Manual redirect-following with re-validation at
  every hop.
- Prompt-injection guard — Tesseract OCR text is wrapped in an
  `<untrusted_ocr>` block with a length cap (4 KB), control-char
  strip, and a closing-tag escape so a label can't break out of the
  block. EXTRACTION_PROMPT Rule #11 tells the model to ignore
  instructions found inside that block.
- Strict MIME allowlist on every upload endpoint (image: jpeg/png/
  webp/heic/heif; application: pdf/json/csv/md/txt/those images). SVG
  / GIF / BMP are 415'd at the route rather than rewritten upstream.
- Per-IP rate limiting on `/api/verify`, `/api/extract`,
  `/api/application/parse`.
- Producer-comparator implicit-USA inference is gated on **strict-
  format** US state code AND **at least one other corroborating
  producer component** — so a hallucinated state can't single-handedly
  pass an obviously-non-compliant country claim.
- Auto-fallback uses a fresh AbortController + remaining-budget timer
  — won't reuse an already-aborted signal from the primary call.
- Batch endpoint pre-checks `Content-Length` before buffering the
  multipart body (DoS guard at 5 GB upper bound, with per-file 10 MB
  enforced inside the loop).
- Security headers in `vercel.json`: HSTS,
  `X-Content-Type-Options: nosniff`, `X-Frame-Options: DENY`,
  `Referrer-Policy: strict-origin-when-cross-origin`,
  `Permissions-Policy` deny-all on sensitive APIs,
  `Content-Security-Policy` `default-src 'self'; img-src 'self' data:
  blob:; connect-src 'self'; frame-ancestors 'none'`.

No authentication / persistent storage — it's a prototype per brief §9.

## Self-hosting

```bash
git clone https://github.com/XanderXML-Bit/label-verify.git
cd label-verify
cp .env.example .env.local
# Fill in at least GOOGLE_API_KEY (get one at
# https://aistudio.google.com/app/apikey).
# Optionally OPENAI_API_KEY for the fallback path.
npm install
npm run dev          # → http://localhost:3000
```

The deployed demo at <https://label-verify-six.vercel.app> uses my
(Xander's) Google API key for the duration of the take-home review.
For your own deploy: provision your own keys, push to Vercel, set
them in **Project Settings → Environment Variables**. The full set
the deployment expects:

| Var | Required? | Purpose |
|---|---|---|
| `GOOGLE_API_KEY` | yes | Primary vision (Gemini 3.1 Flash Lite) |
| `OPENAI_API_KEY` | recommended | Auto-fallback (GPT-5.4-nano) on Gemini outage |
| `OPENROUTER_API_KEY` | optional | Bake-off harness for the long tail |
| `MODEL_PRIMARY` | optional | Defaults to `gemini-3.1-flash-lite` |
| `MODEL_FALLBACK` | optional | Defaults to `gpt-5.4-nano` |
| `VISION_TIMEOUT_MS` | optional | Defaults to 60000 (per-mode policy in verify.ts) |
| `RATE_LIMIT_PER_MIN` | optional | Defaults to 60 |
| `MAX_BATCH_SIZE` | optional | Defaults to 1000 |
| `DEBUG_TOKEN` | optional | Gates `/api/debug/last` ring buffer |

For a custom hostname (e.g. `labelverify.yourdomain.com`): Vercel
Settings → Domains → Add → Vercel issues you a CNAME → add it to your
DNS provider (Cloudflare DNS works fine; set "DNS only" or "Proxied"
depending on whether you want the Cloudflare WAF in front). No
re-hosting needed — DNS routes to the Vercel deployment.

## How to verify

```bash
npm run typecheck    # tsc --noEmit, zero output expected
npm run test         # vitest run, ~340 tests
npm run lint         # next lint, only pre-existing warnings allowed
npm run bench:routine # quick bake-off sanity check (~15 min, ~$0.30)
npm run test:e2e:install && npm run test:e2e
                     # Playwright browser E2E tests
```

The `bench` family of scripts is documented in
[`docs/MODEL-SELECTION.md`](docs/MODEL-SELECTION.md) §3.5. The
benchmark results are committed under `benchmarks/results/` for
reproducibility.

## What's still rough

- **The 88.3 % OOD number.** Photo-realistic labels are harder than
  the SVG synthetics. The current orchestrator handles most of the
  gap via deferral (low-confidence PASS → REVIEW), but a future
  iteration would add a second-opinion vision call on borderline
  Government Warnings — calibrated against a larger real-photo
  corpus we don't have yet. The Codex handoff at
  [`docs/CODEX-BATCH-02-HANDOFF.md`](docs/CODEX-BATCH-02-HANDOFF.md)
  is the next 30-image augmentation targeting Gov-Warning
  paraphrases, photo-quality stress, and novel beverage categories.
- **Single point of dependency.** The deployed demo uses one Google
  API key; if that key is rate-limited, the fallback to GPT-5.4-nano
  fires but the OpenAI bill becomes the operator's problem.
- **5-second budget vs Vercel Hobby 30 s cap.** The verify call lands
  well under 5 s on a warm function, but cold-starts can flirt with
  the cap. A Pro-plan deployment has a 60 s timeout and no concern
  here.
- **Ground-truth adjudication.** AI-generated images have Codex's
  visual-audit notes as the truth source. A human re-audit of the
  ~20 OOD-failures would tighten the OOD number and tell us how much
  of the 12 % gap is model error vs ground-truth error.

## Documentation map

- [`docs/evaluation-brief.md`](docs/evaluation-brief.md) — the brief, verbatim
- [`docs/MODEL-SELECTION.md`](docs/MODEL-SELECTION.md) — bake-off winner + justification
- [`docs/ALTERNATIVES.md`](docs/ALTERNATIVES.md) — non-LLM methods considered
- [`docs/APPROACH.md`](docs/APPROACH.md) — pre-registered hypotheses
- [`docs/ARCHITECTURE.md`](docs/ARCHITECTURE.md) — system design + latency budget
- [`docs/TEST-STRATEGY.md`](docs/TEST-STRATEGY.md) — corpus + Wilson CIs + stratification
- [`docs/government-warning-cases.md`](docs/government-warning-cases.md) — §16.21/§16.22 taxonomy
- [`docs/UI-SPEC.md`](docs/UI-SPEC.md) — UI/UX spec
- [`docs/DEPLOYMENT.md`](docs/DEPLOYMENT.md) — production runbook
- [`docs/CODEX-BATCH-02-HANDOFF.md`](docs/CODEX-BATCH-02-HANDOFF.md) — next-batch corpus prompt
- [`docs/PROJECT-TODO.md`](docs/PROJECT-TODO.md) — locked-in overnight TODO + acceptance criteria

The repo is documentation-first because, for a take-home, the
*decisions* demonstrate the candidate more than half-built features
do. Read the brief, then MODEL-SELECTION §4, and the rest follows.
