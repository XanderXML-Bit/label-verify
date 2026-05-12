# TODO — Prioritized Backlog

> Source of truth for what's left. Updated as work lands. Deadline 2026-05-18.
>
> See [`docs/STATUS.md`](docs/STATUS.md) for the live-state snapshot — what
> works today and what's deployed. This file is the *backlog*: what remains.

Legend: **P0** = must ship · **P1** = strongly want · **P2** = nice to have.

---

## Phase 0 — Foundation — **DONE**

Project skeleton, docs, public repo, multi-agent review pass, all
follow-up iteration, coherence check, ESLint / Next config / deps —
shipped commits `e1c64e0` through `ea10463`.

## Phase 1 — Vertical Slice — **DONE** (shipped `9d5da8e`)

Single-image + batch verify end-to-end, all field comparators, Gov
Warning validator, /api/verify + /api/verify/batch SSE, UploadZone +
DeclaredForm + SingleResult + BatchView, 88 tests green.

## Phase 2 — Corpus + Benchmark Harness — **DONE**

- [x] Scoring library (`benchmarks/score.ts`) with Wilson 95 % CI,
      McNemar, stratify, OOD partition, FN-rate
- [x] Benchmark runner end-to-end (`benchmarks/run.ts`) — iterates
      techniques × corpus × trials, persists JSON + Markdown
- [x] T1 / T4 / T6 / C1 extractor adapters
- [x] v2 corpus (`scripts/generate-corpus-v2.ts` → `test-data-v2/`, 90
      labels, taxonomy coverage verified)
- [x] Codex v1 corpus (`scripts/generate-corpus.ts` → `test-data/`,
      90 labels)
- [x] Corpus Zod validator (`scripts/validate-corpus.ts`)
- [x] First live benchmark — T1 17.9 % / T6 85.0 % CI [78.2, 90.0],
      committed `6f6ebd7`
- [ ] **P0 (Codex)** Real-TTB-COLA corpus (`test-data/ai-generated/` in
      flight); when complete, re-run bake-off against it
- [ ] **P0** Formal bake-off run (npm run bench:bakeoff), result
      committed to `benchmarks/results/`, winner row copied into
      `docs/MODEL-SELECTION.md` §4

## Phase 3 — Pipeline Hardening — **DONE**

All field comparators (brand fuzzy, ABV class-aware, net-contents
unit-convert, producer per-component, country aliases, class aliases),
Gov Warning validator (text / caps / bold / size subscores), pre-process
pipeline (sharp), Tesseract adapter, OCR-bbox bold detection v2
(per-column mean-stroke-thickness, recalibrated to 1.5 / 1.15
thresholds), Gemini Flash extractor, all the way to commit `a99d8b9`.

## Phase 4 — API Surface — **DONE**

- [x] `POST /api/verify` — multipart OR JSON `{url, declared}`, JPEG /
      PNG / WebP / PDF (first-page)
- [x] `POST /api/verify/batch` + `GET /api/verify/batch/:id/stream`
      (SSE streaming from the in-memory batch worker)
- [x] `GET /api/health`, `GET /api/warmup`
- [x] URL fetch with SSRF safeguards (`src/lib/input-handlers.ts`)
- [x] Rate limiter for public demo (`src/lib/rate-limit.ts`)
- [x] `/api/debug/last` introspection (gated by `DEBUG_TOKEN`)
- [x] `/api/queue` human-review queue (`src/lib/review-queue.ts`,
      gated by `DEBUG_TOKEN`)
- [x] PDF page extractor (`src/lib/pdf.ts`)

## Phase 5 — Batch UI — **DONE**

Drag-folder + manifest paste, auto-pair by filename stem, virtualized
results table, filter chips with counts, click-row-to-drill-down, CSV
export, SSE stream wiring.

## Phase 6 — Polish — **DONE**

- [x] Sample-labels affordance (PASS / FAIL / REVIEW pre-populated, one
      click → end-to-end result)
- [x] Empty / error states (network drop, large file, MIME, URL block,
      vision timeout)
- [x] Accessibility (aria-live, focus management, prefers-reduced-motion,
      font-scale, contrast)
- [x] Component-level UI tests (21 tests via @testing-library/react)
- [x] README architecture diagram + routes table + tech stack
- [x] CI badge + GitHub Actions (typecheck + lint + tests + build +
      bench-routine regression guard)
- [x] Dependabot + PR template

## Phase 7 — Model Selection Infrastructure — **DONE**

- [x] **17 extractor candidates** registered:
      - Direct SDK: T1 Tesseract · T4 GPT-4o-mini · T4b GPT-4o full ·
        T5b Claude Haiku 4.5 · T6 Gemini 2.0 Flash · T6b Gemini 2.5
        Flash · T6c Gemini 2.5 Pro · T12 Claude Opus 4.1 · C1 OCR + Vision
      - OpenRouter (frontier long tail): T6d Gemini 3 Pro · T6e Gemini 3
        Flash Lite · T7 GPT-5 · T7b GPT-5 nano · T8 GPT-OSS-120B ·
        T9 NVIDIA Nemotron · T10 Mistral Pixtral · T11 Llama 3.2 Vision
- [x] Bench-output economics (token counts, $/call, $/1k labels,
      acc/$, acc/sec, Pareto frontier)
- [x] `bench:bakeoff` (full) + `bench:routine` + `bench:routine:bakeoff`
      scripts
- [x] Routine sub-corpus (15 curated labels in `benchmarks/routine.ts`,
      manifest at `test-data-v2/routine-manifest.json`)
- [x] CI uses `bench-routine` (cost-conscious regression guard)
- [x] Confidence-first deferral logic (`REVIEW_CONFIDENCE_THRESHOLD =
      0.75` in `verify.ts`)
- [x] `docs/MODEL-SELECTION.md` decision-record template
- [ ] **P0** Run the formal bake-off and fill in §4

## Phase 8 — Deployment — **MOSTLY DONE**

- [x] Vercel project linked, auto-deploys on push to `main`
- [x] Env vars set in Vercel (`GOOGLE_API_KEY`, `OPENAI_API_KEY`,
      `ANTHROPIC_API_KEY`, `MODEL_PRIMARY`, `MODEL_FALLBACK`,
      `VISION_TIMEOUT_MS`, `RATE_LIMIT_PER_MIN`, `DEBUG_TOKEN` optional)
- [x] `vercel.json` (region `iad1`, per-route memory + maxDuration,
      security headers)
- [x] Production smoke (live demo at
      <https://label-verify-six.vercel.app>)
- [ ] **P0** Custom domain on `zendren.net` (or `xandermlopez.com`) —
      Cloudflare CNAME + Vercel Domains + SSL verification
- [ ] **P1** OpenRouter API key in Vercel env (unlocks T6d–T12)
- [ ] **P1** `DEBUG_TOKEN` in Vercel env (unlocks `/api/queue` and
      `/api/debug/last` introspection)

## Phase 9 — Submission — **PENDING USER**

- [ ] **P0** README is impeccable — what / why / run / deploy /
      decisions (DONE; verify with the user)
- [x] Architecture diagram (Mermaid in README)
- [ ] **P0** Short walkthrough video (Loom / screen capture) — link in
      README. **User-authored.**
- [ ] **P0** Submit repo URL + deployed URL to TTB by 2026-05-18

## Risk Watchlist

- [ ] Custom domain SSL slip — fallback `*.vercel.app` URL is in the
      submission docs already; non-blocking.
- [ ] Codex's real-TTB corpus slips — v2 synthetic corpus is the
      fallback; bake-off can still run against it for an interim
      decision.
- [ ] OpenRouter pricing drift — some pricing in `techniques.ts`
      marked `TODO: confirm vs OpenRouter`. If the bake-off becomes a
      cost-comparison, verify those rates first.
- [ ] Bake-off cost — 17 candidates × 90 labels × 3 trials × $0.10–8
      per 1k labels ≈ $1–$5 in API spend. User-gated.

## P2 Backlog (will not block submission)

- C5 tiered escalation orchestrator (fast-then-strong) — already
  implemented (`TieredEscalationExtractor`), pending wiring into the
  production `verify.ts` if the bake-off says it helps
- Photo-of-screen pipeline for real-foil proxy in corpus v3
- Local-VLM behind a hosted GPU endpoint (Modal / Replicate)
- A "compare two labels side-by-side" UI feature
- Persistent storage for batch history (currently in-memory only)
