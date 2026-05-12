# Changelog

> Notable changes only. Routine commits live in `git log`. Dates use
> the project's working timezone (US Pacific). Sections follow Keep a
> Changelog conventions.

## [UX polish + reviewer-export] — 2026-05-12 late

### Added

- **Unified intent-inferring dropzone.** The home page now accepts
  label images and application documents (PDF / JSON / CSV / MD /
  TXT) in a single drop. `handleFiles` classifies what was dropped
  and branches: 1 image → single-pending; 1 image + 1 application
  → single + background `/api/application/parse` that pre-fills the
  form; ≥ 2 images → batch (auto-pair if apps tagged along).
  Implementation in `src/lib/batch-pairing.ts` + `src/app/page.tsx`.
- **Smart batch pairing.** The batch route accepts batches WITHOUT
  a manifest if filenames pair cleanly (e.g.
  `123456-front.jpg` + `123456.pdf`). Two-pass match (strict stem
  + face-tag-stripped fallback for multi-face uploads). The
  response always includes a `pairing` summary the operator can
  inspect before any vision call fires. 13 tests in
  `src/tests/batch-pairing.test.ts`.
- **PDF → vision auto-fallback.** When a PDF application file has
  no extractable text (typical for printed-and-rescanned forms),
  `parseApplication` now renders the first page and routes it
  through the existing vision parser. Source surfaces as
  `pdf-vision-fallback`, confidence `low`, with a warning telling
  the reviewer to double-check the extracted fields. Configured
  by passing `GOOGLE_API_KEY` to `parseApplication`; without the
  key, behaviour falls back to the previous fail-loud error.
- **JSON + CSV export** on every result panel. Single results and
  batch results both download as either format. JSON uses versioned
  schema envelopes (`labelverify.v1.single`, `labelverify.v1.batch`)
  with status tallies and the full `VerifyResponse` per item. CSV
  includes per-field confidence, the Gov-Warning subscore quartet,
  review reasons, fallback indicator, and model id. 9 tests in
  `src/tests/export-result.test.ts`.
- **Country ↔ Producer cross-link** in the orchestrator. When
  `compareCountry` returns REVIEW (label doesn't visibly print a
  country) BUT `compareProducer.components.country` returns PASS
  via implicit-USA inference (strict 2-letter US state + matching
  city/postal), the standalone country field is promoted to PASS
  with a reason that cites the address corroboration. Fixes the
  PASS sample landing on REVIEW. 3 tests in
  `src/tests/verify-country-crosslink.test.ts` pin both the promote
  and the not-promote edge cases.

### Changed

- **DeclaredForm prefill merges, doesn't clobber.** The form used
  a `key`-based remount that wiped user-typed values whenever a
  new prefill arrived. Replaced with a `useEffect` that watches
  `initial` and applies it ONLY to fields still at their default-
  empty value. User-typed values win. Pairs with a new
  `bgAppParse` status indicator on `single-pending` that surfaces
  "Parsing X — form will pre-fill the empty fields" while the
  background parse is in flight.
- **UploadZone accept list** expanded to include the full
  application MIME set (PDF/JSON/CSV/MD/TXT) so the unified flow
  works without users hunting for a second dropzone.
- **ApplicationUpload** now imports the canonical
  `ApplicationParserSource` / `ApplicationConfidence` types from
  `src/lib/application/types.ts` (previously had a local copy that
  drifted from the `pdf-vision-fallback` addition).
- **Lint clean.** The two remaining `consistent-type-imports`
  warnings in vitest partial-mock test files are now explicitly
  suppressed with a "why" rationale. `npm run lint` is now
  zero-output.

### Documentation

- README "How to use it" rewritten to describe the two batch paths
  (explicit manifest vs auto-pair) and the JSON/CSV download.
- `docs/openapi.yaml` `/api/verify/batch` description reflects the
  new request shape (manifest optional) and the response `pairing`
  summary object.
- `docs/REMAINING-IMPROVEMENTS.md` F5/F6/F7 capture three deferred
  items with full scope analysis: DOCX support, speculative
  pre-warming (with security analysis on why it's deferred), and
  multi-image-no-manifest fill-each-form UI.

## [Submission] — 2026-05-12

### Validation

- **Combined-corpus bake-off** on **170 images** (90 SVG-rendered
  synthetic + 80 photo-realistic). Headline: T6 (Gemini 3.1 Flash
  Lite) = **93.8 % field accuracy** (n=1,169) / **3.2 s P50, 4.6 s
  P95** / **$0.25 per 1,000 labels**. Source result file:
  `benchmarks/results/2026-05-12T17-10-53-642Z.md`. (The earlier
  140-image cut at 93.3 % / 2.4 s is superseded; left in the
  `benchmarks/results/` history for reproducibility.)
- ID/OOD split: 95.8 % synthetic SVG vs 88.4 % photo-realistic.
  The OOD subset is the closer-to-real signal.
- Gov-Warning false-negative rate: 5.1 % (n=137, Wilson 95 % CI
  [2.5, 10.2]) — inside the pre-registered ≤ 10 % criterion.
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
  `docs/archive/CODEX-BATCH-02-HANDOFF.md`.
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
- **`/api/health`** initially gated detailed output behind same-
  origin referer or Bearer DEBUG_TOKEN. **Later in the same release
  the same-origin shortcut was removed** (see the
  [Sibling-session consolidation] entry below) — Referer is
  spoofable via cross-origin `fetch`, so it was a fingerprint leak,
  not a security boundary. Final state: anonymous callers get the
  minimal `{ ok, ready, service, notes }` shape; detailed payload
  is reachable only with a valid Bearer token.

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
