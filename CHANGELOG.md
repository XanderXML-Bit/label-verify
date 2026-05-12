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

## [Pre-submission] — 2026-05-08 through 2026-05-11

- Foundation, vertical slice, v1/v2 corpora, deployment, model
  bake-off scaffolding, OCR + classical-CV bold detection, the
  full chain of documentation and tests. See `git log --oneline
  ce47cb5..2bb945c` for the per-commit timeline.
