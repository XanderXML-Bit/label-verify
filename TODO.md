# TODO — Prioritized Backlog

> Source of truth for what's left. Updated as work lands. Deadline 2026-05-18.

Legend: **P0** = must ship · **P1** = strongly want · **P2** = nice to have.

> **Reorganized after the foundation review pass** — see
> [`docs/REVIEW-PASS.md`](docs/REVIEW-PASS.md). The single biggest change:
> a working **vertical slice** ships before any horizontal expansion.
> Treasury Hermes was emphatic: *"One working narrow path beats ten
> planned adapters."*

---

## Phase 0 — Foundation (done)

- [x] Project skeleton + typed stubs
- [x] Docs: `evaluation-brief.md`, `ARCHITECTURE.md`, `APPROACH.md`,
      `TEST-STRATEGY.md`, `DEPLOYMENT.md`, `UI-SPEC.md`
- [x] Public GitHub repo + first commit
- [x] Multi-agent review pass — six sub-agent critiques + two Hermes
      independent reviews → `docs/REVIEW-PASS.md`
- [x] Iteration on the foundation per review pass
      (latency math, kill criterion, structured extractor interface,
      split prefix-bold constants, §16.22 size check, drag-folder
      batch UX, verdict/quality split, 4-technique scope cut)
- [x] `.eslintrc.json`, `next.config.js` (sharp / tesseract external),
      dependencies for the chosen path installed

## Phase 1 — Vertical Slice (P0, ship FIRST)

One image. One extractor (T6 Gemini Flash). Three fields (brand, ABV,
Gov Warning text + caps). One results screen. Deployed URL that works.
This is the slice that proves R1, R5, R8 end-to-end before we expand.

- [ ] **P0** App shell (Next.js, Tailwind, layout)
- [ ] **P0** `POST /api/verify` — single image, single extractor (T6)
- [ ] **P0** `Extractor` adapter for T6 (Gemini 2.0 Flash via direct
      Google SDK with structured output)
- [ ] **P0** Brand-name fuzzy comparator (Levenshtein + token-set; see
      `src/lib/matching/`)
- [ ] **P0** Government Warning *text* validator (the strict body match
      + caps; bold/size are P1 of this slice)
- [ ] **P0** ABV comparator (class-aware percentage-point tolerance per
      `ABV_TOLERANCE_PP`)
- [ ] **P0** Single-label results screen (per `UI-SPEC.md` §2.2),
      including the **Image quality / Verdict split**
- [ ] **P0** Hard 5 s `AbortSignal` on the vision call
- [ ] **P0** Provision Vercel project + deploy a placeholder home page
      (TODAY — DNS + SSL can eat hours)
- [ ] **P0** One end-to-end happy-path vitest covering /api/verify

## Phase 2 — Corpus First, Then Benchmarks (P0)

- [ ] **P0** Build label generator: JSON spec → rendered PNG +
      ground-truth JSON (Puppeteer + parametrized HTML/CSS templates)
- [ ] **P0** Generate 60 clean synthetic labels across beverage types +
      40 non-compliant (per `docs/government-warning-cases.md` taxonomy)
- [ ] **P0** Degradation pipeline (perspective warp, noise, lighting,
      occlusion, curved-bottle); generate 30 variants from clean set
- [ ] **P0** Source + hand-transcribe 10 real public-domain labels from
      TTB's COLA registry; second-model validate; human-resolve any diff
- [ ] **P0** Commit corpus + ground truth to `test-data/` (small images;
      not enormous)
- [ ] **P0** Benchmark runner: T1 / T4 / T6 / C1 across the corpus,
      3 trials per image
- [ ] **P0** Stratified results writer — per (beverage × condition ×
      field) with Wilson 95 % CI
- [ ] **P0** McNemar's test for each technique-vs-technique comparison
- [ ] **P0** OOD column for real-label set, reported separately
- [ ] **P0** Per-field FN rate for Government Warning
- [ ] **P0** Decision record committed in `APPROACH.md` §6 — including
      whether the kill criterion fired and any surprised priors

## Phase 3 — Pipeline Hardening (P0)

- [ ] **P0** Pre-processing pipeline (sharp: EXIF orient, resize ≤ 1600
      px, auto-contrast on low-light histograms)
- [ ] **P0** Tesseract OCR adapter w/ bounding boxes (`OcrWord[]`)
- [ ] **P0** Combined OCR + Vision (C1) adapter — vision prompt
      concatenates OCR text and instructs cross-reference
- [ ] **P0** Government Warning *bold* validator — relative stroke-width
      detection (prefix vs body on same image, ratio ≥ 1.4 = bold)
- [ ] **P0** Government Warning *size* validator — § 16.22 type-size
      minimum from pixel-to-mm estimation (container size from net
      contents)
- [ ] **P0** Net-contents comparator with unit conversion
- [ ] **P0** Structured producer/address parser + per-component diff
- [ ] **P0** Country of origin validator
- [ ] **P0** Class/type validator against controlled vocab
- [ ] **P0** OCR-only graceful degradation path (replaces "local-model
      fallback" — see `APPROACH.md` §2.2)

## Phase 4 — API Surface (P0)

- [ ] **P0** `POST /api/verify` — streaming SSE so the UI renders
      fields as they arrive
- [ ] **P0** `POST /api/verify/batch` — kicks off per-item function
      invocations (see `ARCHITECTURE.md` §5.1) and returns `batchId`
- [ ] **P0** `GET /api/verify/batch/:id/stream` — SSE per-item updates
- [ ] **P0** `GET /api/health`
- [ ] **P0** Multipart upload handler (size limit, MIME whitelist)
- [ ] **P0** URL fetch handler with SSRF safeguards
- [ ] **P1** PDF page extractor (pdfjs-dist); single-page only for v1
- [ ] **P1** Rate limiting for public demo (in-memory token bucket)
- [ ] **P1** `/api/debug/last` gated trace endpoint

## Phase 5 — Batch UI (P0)

- [ ] **P0** Drag-folder + spreadsheet upload (CSV / XLSX) with
      auto-pairing by filename stem
- [ ] **P0** Virtualized results table with persistent
      passed/failed/review tallies
- [ ] **P0** SSE reconnect path with `?cursor=` for mid-batch drops
- [ ] **P0** Filter chips (All / Failed / Review) + sort by confidence
- [ ] **P0** Click row → single-label results view
- [ ] **P1** CSV export of full results
- [ ] **P1** PDF report export
- [ ] **P2** Keyboard shortcuts (j/k next, m mark-reviewed)

## Phase 6 — Polish & Submission (P0)

- [ ] **P0** Three sample labels pre-populated (PASS / FAIL / REVIEW)
      for "Try a sample" affordance
- [ ] **P0** Empty / error states per `UI-SPEC.md` §4 — network drop,
      large file, MIME, URL block, vision timeout
- [ ] **P0** Accessibility pass — aria-live, focus management,
      prefers-reduced-motion, font-scale, contrast checks
- [ ] **P0** Custom domain (`labelverify.zendren.net`) — CNAME +
      Vercel domain + SSL verified
- [ ] **P0** Production smoke test from a clean browser; latency
      surfacing live
- [ ] **P0** README is impeccable: what / why / run / deploy /
      decisions; reading-path list in priority order
- [ ] **P0** Architecture diagram rendered (Mermaid in README)
- [ ] **P0** Short walkthrough video (Loom) — link in README
- [ ] **P0** Submit repo URL + deployed URL to TTB by 2026-05-18

## P2 Backlog (Will Not Block Submission)

- [ ] **P2** T5 Claude Sonnet vision adapter (provider parity check)
- [ ] **P2** C5 Tiered escalation orchestrator (fast-then-strong)
- [ ] **P2** Photo-of-screen pipeline for real-foil proxy in corpus v2
- [ ] **P2** v2 corpus expansion (25–30 real labels)
- [ ] **P2** Local-VLM behind a hosted GPU endpoint (Modal / Replicate)
      — only if implementation time remains and the C6 honest fallback
      is judged insufficient
- [ ] **P2** PDF report export with verdict per page

## Risk Watchlist

- [ ] **Vercel cold-start** — `/api/health` warmup pinger lives in the
      app shell.
- [ ] **Vision API timeouts** — 5 s `AbortSignal` and OCR-only
      degradation are in the design, not aspirational.
- [ ] **Tesseract.js cold load** — load lazily on first OCR call,
      preload via the warmup pinger.
- [ ] **Hand-transcribed ground-truth errors** — second-model
      cross-check + spot-check on 20 % of synthetic.
- [ ] **PDF edge cases** — start with one-page only.
- [ ] **DNS / SSL slip** — fallback `*.vercel.app` URL is acceptable;
      the README will include both.
- [ ] **Scope creep** — anything tagged P2 stays P2.
