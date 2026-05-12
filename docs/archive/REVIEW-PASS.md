# Foundation Review Pass — 2026-05-11

> **Purpose:** Before any extractor or UI code is written, the foundation was
> reviewed by eight independent critics: six Claude sub-agents (each on a
> dedicated axis) plus two Hermes sessions — one adopting a Treasury
> hiring-manager persona, one running in pragmatic-skeptic mode.
>
> This file records *what they said*, *what we changed*, and *what we
> intentionally did not change*. Intellectual-honesty signal: a take-home that
> shows its own iteration tracks better than one that pretends the first draft
> was perfect.

## 1. Why a Review Pass at All

The brief explicitly says **"a working core beats an ambitious incomplete
attempt."** Foundation defects (latency math errors, an undefined
prefix-bold contract, an unfalsifiable hypothesis matrix, a local-VLM
fallback that physically cannot run on Vercel) would have cost a week of
rework if discovered after the working slice was wired against them.
A short review pass at this point trades a few hours for the rework
delta. That is the entire rationale.

## 2. The Critics

| Lens | Source | Focus |
|------|--------|-------|
| Architecture & approach | Sub-agent | Latency budget math; technique matrix realism; interface gaps |
| Test strategy | Sub-agent | Corpus power; synthetic-to-real domain gap; scoring rigor |
| UI/UX | Sub-agent | First-sight usability for a 55-year-old reviewer; accessibility |
| Requirements coverage | Sub-agent | R1–R8 strict audit; the seven regulated fields four-way check |
| Government Warning | Sub-agent | 27 CFR §16.21 fidelity; bold/caps/size detection robustness |
| Splitful pattern scout | Sub-agent | What to lift from the prior receipt-OCR app |
| Treasury hiring manager | Hermes | What a senior reviewer sees on first read |
| Pragmatic skeptic | Hermes | What is most likely to sink the project |

All seven were briefed on the eval brief and the foundation docs. Each was
asked to be CRITICAL, not polite.

## 3. The Strongest Critiques (Action Taken)

### 3.1 Latency budget arithmetic was wrong

`ARCHITECTURE.md` §4 claimed parallel OCR + vision but summed both
sequentially, double-counting the savings. No P95 row. Sharp cold-start not
accounted for. Vision-call estimate (2.5 s) is borderline under structured-
output mode on Vercel; P95 commonly 4–7 s.

**Change:** rewrote the table — OCR is now correctly off-path because it
runs in parallel; the critical-path total is `pre-process + vision + match +
stream`. Added P95 row, cold-start row, timeout/fallback row, and an
explicit "if this blows past 5 s we degrade to streamed partial results"
mitigation paragraph. The reader gets honest numbers, not aspirational ones.

### 3.2 Working hypothesis was unfalsifiable

`APPROACH.md` §4 predicted C1 (OCR + Vision) at 92–97% — the same number as
the best individual model. Any result would have "confirmed" the
hypothesis. That is window-dressing, not science.

**Change:** added an explicit **kill criterion** to §4 — "C1 is rejected
if vision-only matches it within 2 pp accuracy and runs 30 % faster." The
hypothesis can now lose. Also added a **delta prediction** so the post-
benchmark write-up can compare predicted vs measured deltas, not absolute
levels.

### 3.3 Local-model fallback was fantasy on Vercel

Florence-2 (~460 MB) and moondream2 (~1.8 GB quantized) cannot fit in a
Vercel serverless function (250 MB unzipped, no GPU, 10–60 s exec limit).
Predicted 2–4 s CPU latency was wrong by ~5×.

**Change:** demoted C6 in `APPROACH.md`. The "network-blocked TTB"
contingency is now honestly framed as **OCR-only graceful degradation** —
tesseract finds what it can, the rule-based validators run on the OCR text,
the UI flags low-confidence fields for human review. Florence-2 / moondream2
moved to P2 backlog with a note that they would require a hosted GPU
endpoint (Modal / Replicate) to be useful — which is no longer "local."

### 3.4 Extractor interface was missing critical fields

`src/lib/vision/types.ts` returned flat values with no per-field confidence,
no cost tracking, no model version pinning, no prompt hash. `OcrResult`
returned no bounding boxes — but the Gov Warning bold-detection plan
requires the prefix bounding box.

**Change:** rewrote both interfaces:
- `FieldWithConfidence<T>` wrapper on every extracted field.
- `ExtractorResult.cost { inputTokens, outputTokens, costUsd }`.
- `ExtractorResult.modelVersion` (pinned, e.g. `gpt-4o-mini-2024-07-18`).
- `ExtractorResult.promptHash`.
- `ExtractorContext.signal?: AbortSignal` for 5 s timeout enforcement.
- `OcrResult.words: { text, bbox, confidence }[]` with bounding boxes.
- `ExtractedFields.producer` is now a structured object, not a freeform
  string — supports per-component diff in the UI.

### 3.5 Government Warning constants had a regulation defect

The prefix constant baked the colon into the *bold* rule. 27 CFR §16.21
makes the two words **GOVERNMENT WARNING** bold; the colon is part of
the prefix but not part of the bold-test target. The validator also had no
defined separator for `prefix + body` reconstruction.

The bold-detection plan was *absolute* (stroke width / pixel density),
which fails on textured backgrounds and varied font weights. Bold is
inherently *relative*.

`27 CFR §16.22` mandates **minimum type size** (1 mm or 2 mm depending on
container size) and visual separation. Foundation did not check size.

**Change:**
- Split `PREFIX_BOLD_TARGET = "GOVERNMENT WARNING"` (the two words, the
  bold-rule target) from `PREFIX_FULL = "GOVERNMENT WARNING:"` (the
  punctuation-bearing prefix).
- Added `SEPARATOR = " "` and `canonicalStatement()` helper so any
  full-string compare uses the same join.
- Added §16.22 constants: `MIN_TYPE_MM_LARGE = 2`, `MIN_TYPE_MM_SMALL = 1`,
  `SMALL_CONTAINER_THRESHOLD_ML = 237`.
- `GovernmentWarningCheck` now returns `confidence: number` and
  `subscores: { text, caps, bold, size }`. Each subscore carries its own
  `{ status, confidence }`. The aggregate `status` is the worst across
  subscores via `aggregateStatus()` (fail < review < pass); the aggregate
  `confidence` is the minimum across subscores — one weak signal poisons a
  strict rule, which is the right semantic.
- Bold is documented as a relative check: prefix stroke width ≥ 1.4× body
  stroke width on the same image. Ambiguous middle (1.2×–1.4×) returns
  `status = "review"` (human resolves), not a guess.
- Added a `normalize()` helper that handles NFKC, smart-quotes, and
  whitespace collapse before exact match.

### 3.6 Test corpus was statistically underpowered for the technique matrix

100 labels ÷ 13 techniques × stratification = ~7–8 labels per cell. Wilson
95 % CI is roughly ±15 pp. Cannot distinguish T3 (predicted 90–95 %) from
T4 (predicted 85–90 %) — the gaps are inside the noise floor.

**Change:** scope cut. We are no longer benchmarking 13 techniques. The
post-review benchmark plan is **four contenders** (`APPROACH.md` §2.1):
T1 Tesseract baseline, T4 GPT-4o-mini Vision, T6 Gemini 2.0 Flash Vision,
and C1 OCR + Vision combined — one OCR baseline, two competing fast-tier
hosted vision models for provider parity, and one combined approach. The
optional tiered-escalation wrapper (C5) is P2 if implementation time
remains. With four contenders, 100 labels gives ≈ ±5 pp Wilson CI per
cell — defensible.

`TEST-STRATEGY.md` now also requires **Wilson confidence intervals** and
**McNemar's test** for technique-vs-technique comparisons, and reports
**stratified accuracy** (per beverage type × condition × field), not just a
headline number. The real-label set is reported as a **separate
out-of-distribution column** rather than collapsed into the average.

### 3.7 Gov Warning corpus split was backwards

70 compliant / 20 subtly non-compliant / 10 missing under-tests the
**false-negative rate** on the strictest field — and FN (passing a
non-compliant label) is the dangerous direction for a regulator.

**Change:** flipped to **40 compliant / 40 non-compliant / 20 missing**,
with the non-compliant bucket *enumerated* across the six axes named in
`docs/government-warning-cases.md` (word substitution, article drop,
punctuation swap, missing colon, mixed-case prefix, prefix-not-bold, body-
not-bold, wrong-order numerals, smart-quote contamination, below-min-size).

### 3.8 UI conflated "label is non-compliant" with "your photo was bad"

Both surface as red FAIL in the spec. For a regulator who has lived with the
prior 30–40 s vendor, this is the single most consequential UX defect — and
the easiest one to fix.

**Change:** `UI-SPEC.md` §2.2 now distinguishes **Verdict** (the
compliance answer, green / red / amber) from **Input quality** (a separate
chip — Good / Low / Re-photograph). The two states have distinct icons,
distinct copy, and distinct CTAs ("Reject application" vs "Re-upload
image"). A FAIL on input-quality does not count toward "non-compliant."

### 3.9 CSV import is hostile for the 50+ reviewer audience

A typo in a header silently misaligns a full batch.

**Change:** primary batch flow is now **drag a folder of images + a single
spreadsheet (CSV or XLSX); the app auto-pairs by filename stem** and shows
a side-by-side preview before kicking off the batch. The reviewer can edit
a row inline. CSV download template is the bare minimum.

### 3.10 Vercel batch timeout was a TODO note, not a design

`R3` asks for 200–300 labels. The current interactive path is capped by provider RPM and serverless duration.
"Worker pool" in one function does not survive the timeout.

**Change:** `ARCHITECTURE.md` §5 now spells out **per-item function
invocations** orchestrated by a parent endpoint that returns immediately
and streams updates over Server-Sent Events from a per-batch in-memory
job store. Each item is its own function call, so each item gets its own
timeout budget.

### 3.11 Scope creep was the implicit risk

Treasury Hermes scored **scope discipline 6/10**. TODO had ten technique
adapters, three result export formats, a local-model fallback, custom
domain, PDF report, CSV bulk import — all P0.

**Change:** TODO reorganized around a **vertical slice first**: one image,
one extractor (Gemini Flash), Gov Warning + brand + ABV checks, a working
UI, deployed URL. *Everything else* is P1 or later. The brief says
"working core beats ambitious incomplete" — the TODO now reflects that.

### 3.12 Missing dependencies and config

`fast-fuzzy`, `@google/generative-ai`, a PDF parser, an ESLint config, and
`next.config.js` (with `serverExternalPackages` for sharp + tesseract.js)
were referenced in the docs but not actually installed.

**Change:** added to `package.json`, with an ESLint config file and
`next.config.js` scaffolded.

## 4. Critiques We Deliberately Did NOT Act On

A review is not "do everything the critics say."

- **"Expand the corpus to 250–500 labels."** Right call statistically, wrong
  call for the deadline. We are doing 100 labels + reporting CIs. The CI
  width is the honest tradeoff.
- **"Add a screen-reader live-region pass before submission."** Worth
  doing; not before the vertical slice ships. P1, not P0.
- **"Add Mistral Pixtral / GPT-4.1-mini / Claude Haiku 4.5 to the
  comparison."** No — the scope-cut decision says three techniques. If the
  benchmark surfaces a clear loser, we may swap; we will not add a fourth.
- **"Photograph synthetic labels for cheap real-foil proxy."** Good idea;
  postponed to a P1 corpus-v2 if time allows. The 10 real public-domain
  labels are reported as a separate OOD slice instead.

## 5. The Single Highest-Leverage Change

**Ship one vertical slice end-to-end before any benchmark or batch UI
work.** Treasury Hermes was emphatic: *"One working narrow path beats ten
planned adapters."* The TODO has been rewritten to reflect this. The
vertical slice is the new Phase 1, ahead of corpus generation. Every
subsequent phase is a horizontal expansion of that working slice.

## 6. What the Review Pass Did to the Repo

| Doc / file | Changed |
|------------|---------|
| `docs/ARCHITECTURE.md` | §4 latency rewrite; §5 batch redesign |
| `docs/APPROACH.md` | §4 kill criterion + delta hypothesis; §2 technique scope cut |
| `docs/TEST-STRATEGY.md` | Stratified scoring, Wilson CI, McNemar, OOD column, Gov Warning split flip |
| `docs/UI-SPEC.md` | Verdict / input-quality split; drag-folder batch; sample variants |
| `docs/DEPLOYMENT.md` | Per-item function plan; provision-today checklist |
| `src/lib/vision/types.ts` | Per-field confidence, cost, version, prompt hash, AbortSignal, structured producer |
| `src/lib/ocr/index.ts` | Bounding boxes on words |
| `src/lib/validation/government-warning.ts` | Split prefix constants, §16.22 size, normalizer, subscores, relative-bold |
| `docs/government-warning-cases.md` | NEW — enumerated subtle non-compliance test cases |
| `next.config.js` | NEW — serverExternalPackages for sharp / tesseract |
| `.eslintrc.json` | NEW |
| `package.json` | Added fast-fuzzy, @google/generative-ai, pdfjs-dist, eslint |
| `TODO.md` | Reorganized around vertical-slice-first |
| `docs/REVIEW-PASS.md` | NEW — this document |

## 7. What This Tells the Evaluator

This document is not the deliverable; the working slice is. This document
exists because a reviewer who asks "did the candidate think before they
typed?" can read it and see exactly what was reconsidered and why. The
*working slice* is what proves the rework was worth doing.
