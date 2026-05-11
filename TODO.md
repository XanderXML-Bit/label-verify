# TODO — Prioritized Backlog

> Source of truth for what's left. Updated as work lands. Deadline 2026-05-18.

Legend: **P0** = must ship · **P1** = strongly want · **P2** = nice to have.

---

## Phase 0 — Foundation (this commit)

- [x] Create project skeleton
- [x] Write `evaluation-brief.md`, `ARCHITECTURE.md`, `APPROACH.md`,
      `TEST-STRATEGY.md`, `DEPLOYMENT.md`, `UI-SPEC.md`
- [x] Create public GitHub repo
- [x] First commit pushed

## Phase 1 — Test Corpus First (P0)

Without ground truth we can't benchmark. So this happens before any
extractor work.

- [ ] **P0** Design synthetic-label HTML/CSS templates (beer, wine, spirits)
- [ ] **P0** Build label generator: JSON spec → rendered PNG + ground-truth JSON
- [ ] **P0** Generate 70 clean synthetic labels across beverage types
- [ ] **P0** Build degradation pipeline (perspective, noise, lighting, occlusion)
- [ ] **P0** Generate 30 degraded variants
- [ ] **P0** Source + hand-transcribe 10 real public-domain labels
- [ ] **P0** Validate hand-transcribed ground truth against an advanced VLM
- [ ] **P0** Commit corpus + ground truth to `test-data/`
- [ ] **P1** Generation script is deterministic (seeded)

## Phase 2 — Benchmark Harness (P0)

- [ ] **P0** Define `Extractor` interface (`src/lib/vision/types.ts`)
- [ ] **P0** Field-scoring functions (exact, numeric, fuzzy, gov-warning)
- [ ] **P0** Benchmark runner: iterate techniques × corpus, record results
- [ ] **P0** Results writer: JSON + Markdown summary table
- [ ] **P1** GitHub Action that runs `bench:smoke` on every PR

## Phase 3 — Extractor Implementations (P0)

In rough order of priority — we stop adding once we have a clear winner.

- [ ] **P0** T1 Tesseract OCR adapter (server-side `tesseract` or `tesseract.js`)
- [ ] **P0** T3/T4 OpenAI Vision adapter (structured output via `zod`)
- [ ] **P0** T6 Gemini Flash adapter (via OpenRouter)
- [ ] **P0** T5 Claude Sonnet adapter (Anthropic SDK)
- [ ] **P0** C1 combined OCR + Vision adapter
- [ ] **P1** T7 Florence-2 local adapter (Transformers.js / ONNX)
- [ ] **P1** C5 tiered escalation orchestrator
- [ ] **P2** T2 PaddleOCR adapter
- [ ] **P2** T8 moondream2 adapter
- [ ] **P2** T9 Google Document AI adapter
- [ ] **P2** T10 AWS Textract adapter

## Phase 4 — Run Benchmarks & Decide (P0)

- [ ] **P0** Run full benchmark across implemented techniques
- [ ] **P0** Publish results table to `benchmarks/results/`
- [ ] **P0** Record decision in `APPROACH.md` §6
- [ ] **P0** Note any prior we got wrong (intellectual honesty signal)

## Phase 5 — Verification Pipeline (P0)

- [ ] **P0** Field schema (zod) for declared application + extracted output
- [ ] **P0** Pre-processing pipeline (sharp: orient, resize, contrast)
- [ ] **P0** Brand name fuzzy matcher (normalized Levenshtein)
- [ ] **P0** ABV numeric comparator with class-aware tolerance
- [ ] **P0** Net-contents comparator with unit conversion
- [ ] **P0** Government Warning text validator (exact regulated string)
- [ ] **P0** Government Warning bold + caps detector
- [ ] **P0** Producer / address fuzzy matcher
- [ ] **P0** Country of origin validator
- [ ] **P0** Class/type validator against controlled vocab
- [ ] **P0** Per-field confidence scoring
- [ ] **P0** Aggregate verdict producer

## Phase 6 — API (P0)

- [ ] **P0** `POST /api/verify` — single label, streaming
- [ ] **P0** `POST /api/verify/batch` — kicks off a batch job
- [ ] **P0** `GET /api/verify/batch/:id/stream` — SSE for batch progress
- [ ] **P0** `GET /api/health`
- [ ] **P0** Multipart upload handler (size limit, MIME whitelist)
- [ ] **P0** URL-fetch handler (with SSRF safeguards)
- [ ] **P0** PDF page extractor (pdf.js)
- [ ] **P1** Rate limiting for public demo
- [ ] **P1** `/api/debug/last` gated trace endpoint

## Phase 7 — UI (P0)

- [ ] **P0** App shell, Tailwind, shadcn/ui setup
- [ ] **P0** Upload zone (drag/drop + click + URL input)
- [ ] **P0** Application data form (single + CSV import)
- [ ] **P0** Single-label results view per `UI-SPEC.md`
- [ ] **P0** Batch progress + virtualized results table
- [ ] **P0** Per-field PASS / FAIL / REVIEW chips with reasons
- [ ] **P0** Sample-labels "Try a sample" affordance
- [ ] **P1** CSV export of batch results
- [ ] **P1** PDF report export
- [ ] **P2** Keyboard shortcuts for batch triage

## Phase 8 — Deployment (P0)

- [ ] **P0** Vercel project linked to GitHub repo
- [ ] **P0** Env vars set in Vercel
- [ ] **P0** `.env.example` covers every var
- [ ] **P0** Custom domain on `zendren.net` (or fallback to vercel.app URL)
- [ ] **P0** SSL verified
- [ ] **P0** Production smoke test from a clean browser

## Phase 9 — Polish & Submission (P0)

- [ ] **P0** README is impeccable: what / why / run / deploy / decisions
- [ ] **P0** Architecture diagram rendered (Mermaid in README)
- [ ] **P0** Loom or short video walking through the UI (link in README)
- [ ] **P0** All P0 items above complete
- [ ] **P0** Submit repo URL + deployed URL to TTB by 2026-05-18

## Risk Watchlist

- [ ] Network access to OpenAI / Anthropic / OpenRouter — have at least one
      local-model fallback ready.
- [ ] Vercel function timeout for batch jobs — confirm we're not blocking
      a single function call for the whole batch; per-item streaming is the
      mitigation.
- [ ] Tesseract.js bundle size on cold start — load lazily.
- [ ] Hand-transcribed ground truth errors — always cross-check with a
      second model.
- [ ] PDF parsing edge cases — start with one-page PDFs only for v1.
