# Changelog

> Notable changes only. Routine commits live in `git log`. Dates use
> the project's working timezone (US Pacific). Sections follow Keep a
> Changelog conventions.

## [Submission] — 2026-05-12

### Validation

- **Combined-corpus bake-off** rerun on 170 images (90 SVG +
  80 photo-realistic). Headline: T6 (Gemini 3.1 Flash Lite) =
  93.3 % field accuracy / 2.4 s P50 / $0.25 per 1k labels on the
  earlier 140-image cut; full 170-image numbers in
  `benchmarks/results/`.
- ID/OOD split now reported separately (96 % synthetic vs 88 %
  photo-realistic). The OOD subset is the closer-to-real signal.
- Wilson 95 % CIs on every accuracy number.
- Hermes outside-reviewer pass on the headline framing.

### Added

- **Loading bar + elapsed-time counter** during verify/extract. Soft
  "still working" copy past 10 s.
- **API status banner** on page load — warns if a provider key is
  missing in the deployment env before the user submits anything.
- **Auto-fallback** to GPT-5.4-nano (OpenAI) on Gemini failure. Yellow
  banner on result when fired. Fresh AbortController + remaining-
  budget timer (capped at 25 s for Hobby-plan safety).
- **AI-photographed sample affordances** — three real-photo labels
  replace the prior SVG renders so the demo shows representative
  behaviour, not best-case.
- **Application-document parser** — PDF / JSON / CSV / Markdown / TXT
  / image-of-form; populates the editable form via
  `/api/application/parse`.
- **Image-only extract path** — `/api/extract` for the case where no
  application data is on hand. Renders a yellow disclaimer banner so
  the user can't mistake an extraction for a verification.
- **Producer-country inference** — labels that print "Portland, ME"
  without an explicit "USA" no longer mismatch the country field. Two
  guards: strict 2-letter state code, plus at least one corroborating
  producer component. 17 regression + spoof-resistance tests added.
- **Codex Batch 02 corpus** — 30 targeted images (paraphrase stress,
  photo-quality stress, novel beverage categories like sake / cider /
  bilingual) generated via the handoff in
  `docs/CODEX-BATCH-02-HANDOFF.md`.
- **Batch endpoint cap raised** from 300 to 1000 with a 5 GB
  `Content-Length` pre-check before `formData()` buffering.

### Changed

- **Mode picker removed** from the UI. The bake-off settled which
  model wins; offering "Smart" / "Fast" / "Balanced" / "Local" to a
  non-technical reviewer would mis-lead them. Underlying mode catalog
  retained for the bench harness and a future operator A/B knob.
- **README** rewritten as the submission report. Leads with corpus
  composition; per-field results, methodology, security posture, and
  self-host instructions all in one document.
- **`/api/health`** gated detailed output behind same-origin referer
  or Bearer DEBUG_TOKEN. Anonymous callers get the minimal
  `{ ok, ready, service }` only — closes a deployment-fingerprint
  leak.

### Security

- SSRF guard on URL fetch now rejects non-canonical IPv4 literal
  forms (decimal, hex, octal). CGNAT + 255.255.255.255 multicast in
  the private-IP set.
- Prompt-injection wrapper around OCR text fed into the vision call.
  Length cap (4 KB), control-char strip, closing-tag escape so the
  block can't be broken out of.
- Strict MIME allowlist on every upload endpoint; SVG/GIF/BMP rejected.
- CSP / X-Frame-Options: DENY / Permissions-Policy /
  Referrer-Policy added to all routes in `vercel.json`.
- Auto-fallback signal hygiene (fresh controller, bounded budget).
- `next` floor pinned to `^15.2.3` to dodge CVEs in earlier 15.x.

### Fixed

- Vercel 504 on `/api/warmup` / `/api/verify` — Next.js standalone
  build trace wasn't bundling `tesseract.js-core` WASM. Forced via
  `outputFileTracingIncludes`. Belt-and-suspenders: bounded timers
  around every Tesseract await.
- Vercel deploy memory cap — Hobby plan reduced from 3009 → 2048 MB.
  `vercel.json` aligned.

### Reproducibility

- `npm run bench` accepts `--trials N` for fast full-corpus passes
  (cuts a 140-image run from ~50 min to ~7 min when 1 trial suffices).
- `--corpus test-data-combined` routes the bench at the unified
  170-image corpus.
- Benchmark result JSON/MD pairs committed under `benchmarks/results/`
  so a reviewer can re-read any historical run.
- **Per-image bench output** — `benchmarks/run.ts` now writes a
  `<run-id>-per-image.json` alongside the summary so per-(image,field)
  outcomes can be re-analysed offline without rerunning the bench.

## [Sibling-session consolidation] — 2026-05-12 evening

Audited and merged the kind-banzai Claude worktree's "Audit fixes"
commit hypercritically. Most changes were real improvements; took
the merge with three deliberate amendments.

### Validation

- Full test suite at 359 passing (up from 353; +6 from new UI specs).
  `tsc + lint + build` all green after the merge.

### Security

- **`crypto.timingSafeEqual`** bearer check (`src/lib/debug-token.ts`)
  on every DEBUG_TOKEN-gated route (`/api/debug/last`, `/api/queue`,
  `/api/queue/:id/resolve`, `/api/health`). Replaces inline string
  comparison; closes a timing-attack surface that the earlier
  session left open.
- **`/api/queue` and `/api/queue/:id/resolve`** are now Bearer-gated
  on the API. Pre-merge: anyone could read pending human-review
  items. Post-merge: same auth contract as `/api/debug/last`.
- **`/api/health`** drops the spoofable Referer same-origin
  shortcut. Detailed payload only with a valid Bearer token; when
  `DEBUG_TOKEN` is unset the detailed shape is unreachable. Closes
  a deployment-fingerprint leak the earlier same-origin path
  shipped.
- **`/api/verify/batch`** gains a per-IP `batch:` rate-limit bucket
  (60/min default, distinct from the other three endpoint buckets)
  + BatchStoreFullError 503 handling + Content-Length pre-check at
  5 GB (reconciled from bacc632's 1.2 GB to match MAX_BATCH=1000).
- **`lib/rate-limit.ts`** `callerKey()` now prefers
  `x-vercel-forwarded-for` over the spoofable `x-forwarded-for`.

### Added

- **PDF rasterization** via `@napi-rs/canvas` + pdfjs canvasFactory
  (`src/lib/pdf.ts`). Without this fix the vision model didn't see
  real glyphs on PDF uploads; Government Warning bold detection
  was silently broken on PDFs.
- **SSE-abort plumbing**: batch-stream client disconnect now
  aborts in-flight vision calls via an external `AbortSignal`
  threaded into `verifyLabel`. Stops billing once the user
  navigates away.
- **Cross-batch memory ceiling** (2 GB) + 30-minute TTL sweep in
  `lib/batch-store.ts` with a typed `BatchStoreFullError`.

### Changed

- **Class comparator**: `pilsner`/`lager`, `imperial stout`/`stout`
  now return REVIEW (was PASS). TTB distinguishes these styles for
  the class designation; surfacing as REVIEW lets a human confirm
  rather than silently treating them as identical.
- **Government Warning size subscore**: no longer FAILs alone. The
  px-to-mm conversion has no aspect-ratio correction so a cropped
  photo would otherwise drive false-FAILs. Worst case is now
  REVIEW; a truly non-compliant warning will FAIL on text + caps +
  bold anyway.
- **UK constituent countries** (Scotland, Wales, Northern Ireland)
  now alias to "United Kingdom" in the country comparator.
- **BatchView** drilldown renders `SingleResult` instead of raw
  JSON; SSE disconnect surfaces an inline "connection dropped"
  banner with reconnect; `friendlyError()` everywhere.
- **ReviewQueuePanel** replaces `window.prompt()` with an inline
  password input (kept the new empty-state copy).
- **UploadZone** collapses the double-affordance into a single
  interactive button.
- **VerifyProgress** aria-live announces only on threshold
  crossings, not 10 Hz (no more screen-reader spam).
- **ExtractionOnlyResult** adds a "Now compare against application
  data" button that pre-fills DeclaredForm.
- **SettingsPanel.tsx** and its test deleted (dead code; the
  mode-picker UI was removed in an earlier session).

### Documentation

- `SECURITY.md` updated for the new auth contract on `/api/health`
  + queue routes; `npm audit` posture documented (2 moderate findings
  in postcss via next, both build-time-only false-positives).
- `docs/openapi.yaml`: `/api/queue` now requires `debugBearer`;
  `/api/health` description reflects no-same-origin gate.
- `docs/MODEL-SELECTION.md`, `.env.example`, `DEPLOYMENT-CHECKLIST`,
  `TODO.md`: env-var contract reconciliation; MAX_BATCH=1000 across
  the board.
- Older handoff docs moved to `docs/archive/` (CODEX-HANDOFF,
  CODEX-BATCH-02-HANDOFF, REVIEW-PASS).

### `.gitignore`

- `.claude/worktrees/` and `.review/calibrate-log.txt` added so
  agent worktrees and per-run logs don't accidentally end up
  staged.

## [Submission polish] — 2026-05-12 afternoon

### Validation

- **Formal threshold calibration** of `REVIEW_CONFIDENCE_THRESHOLD`
  via `scripts/calibrate-review-threshold.ts`. Sweeps τ ∈ [0.30, 0.95]
  against the 170-image corpus under the pre-registered loss
  (`3 · FPD + 5 · MWP`). Confirms current 0.55 is on the Pareto
  plateau — no change. Full report in
  `.review/threshold-calibration-report.md`.

### Added

- **X-Request-Id middleware** on every `/api/*` route. Inbound allowlist
  (128 chars, `[A-Za-z0-9_-]`) or fresh UUIDv4. Error responses
  surface the id in the body so users can paste it when reporting a
  failure.
- **Gemini SDK warmup** in `/api/warmup` (parallel with Tesseract).
  Pulls the SDK module + client constructor into the function's
  module cache during page-load warmup — saves ~150 ms on the first
  user verify.
- **Per-call cost pill** on SingleResult (`≈ $0.00025 per call` next
  to latency). Hover shows the per-1k extrapolation.
- **Mobile collapse** of the 4-part Gov-Warning subscore block under
  `sm:hidden`; auto-opens on non-PASS so failure detail is still
  immediate.
- **Auto-expanded producer breakdown** on REVIEW/FAIL — reviewer sees
  the failing component(s) without an extra click.
- **"Look for:" hint** on the FAIL and REVIEW sample buttons —
  defect readable from the thumbnail row.
- **Stratified bench sanity test** (`bench-stratum-sanity.test.ts`)
  — flags any (beverage × condition × field) stratum at 0 % over
  n ≥ 20.
- **Live-URL Playwright workflow** (`.github/workflows/e2e-live.yml`)
  — nightly + on-demand against the production deployment.

### Documentation

- **`SECURITY.md`** at repo root — reporting channel, threat model,
  mitigations.
- **`CONTRIBUTING.md`** — setup, three common extensions, prompt-hash
  contract, CI gates.
- **`docs/FAILURE-MODES.md`** — 7 failure clusters + 3 orchestrator
  safeguards + 3 known limits.
- **`docs/openapi.yaml`** — full OpenAPI 3.1 spec for the public API
  surface.
- **`docs/DEPLOYMENT.md` §7a** — Hobby vs Pro Vercel-plan deltas with
  upgrade procedure.

## [Pre-submission] — 2026-05-08 through 2026-05-11

- Foundation, vertical slice, v1/v2 corpora, deployment, model
  bake-off scaffolding, OCR + classical-CV bold detection, the
  full chain of documentation and tests. See `git log --oneline
  ce47cb5..2bb945c` for the per-commit timeline.
