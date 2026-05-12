# Remaining Improvements — Extensive Backlog

> Compiled 2026-05-12 after the morning sprint. Each item names a real
> issue, a concrete deliverable, and an honest "is this worth doing
> for the take-home" call. Ordered roughly by accuracy impact, then by
> effort. Items already done are NOT here — see `CHANGELOG.md`.

## Accuracy & verifier behaviour

### A1. Document the country-of-origin scoring asymmetry — **DONE in code, document in README**
Today the per-field bench scorer counts a REVIEW status as
"incorrect." The new `compareCountry` logic returns REVIEW for the
"declared USA + label doesn't print a country" case. This is
*correct* production behaviour (US-domestic labels legitimately omit
the country marking) but the bench number doesn't reflect that
because the scorer is binary. The right fix:
- Bench scorer: add a `reviewIsHalfCredit` mode that counts REVIEW as
  0.5 toward accuracy (or split-report).
- README: explicitly note that the OOD number undersells because of
  the binary scorer + the ground-truth's USA over-claims.

### A2. Calibrate `REVIEW_CONFIDENCE_THRESHOLD` against the 170-image data — **DONE 2026-05-12**
Implemented in `scripts/calibrate-review-threshold.ts`. Result:
`loss(τ)` is flat at 30 across τ ∈ [0.30, 0.90] (6 missed wrong-PASSes
× 5 weight, 0 false-positive defers). τ ≥ 0.91 adds 3 FPDs without
catching any additional wrong PASSes. Current production τ = 0.55 is
on the Pareto plateau — **no change needed**. Full sweep table and
analysis in `.review/threshold-calibration-report.md`. The 6 wrong
PASSes can't be caught by raising τ because the model was confidently
wrong (conf ≥ 0.90) — they need a second-opinion model, see A8.

### A3. Re-run T6 with the new comparators to refresh the headline
`compareCountry` was relaxed for US-domestic labels (REVIEW instead
of FAIL). A fresh `npm run bench -- --corpus test-data-combined
--technique T6 --trials 1` would show the new orchestrator-level
accuracy. The per-field scorer treats REVIEW as wrong so the bare
field-level number won't move, but the orchestrator-level
PASS-FAIL-REVIEW breakdown will (fewer FALSE FAILs, more REVIEWs).

### A4. Capture per-image outcomes during the formal bake-off — **DONE 2026-05-12**
`benchmarks/run.ts` now writes `<run-id>-per-image.json` alongside
the summary JSON / MD. Contains per-(image,field) outcomes and per-
trial latency / cost / error records. Enables offline calibration
(see A2) and stratum re-analysis without rerunning the bench.

### A5. Ground-truth audit of the AI corpus
Codex's `country_of_origin` field over-claims USA on labels that
don't visibly print one (the cross-validation oracle pass at
`.review/ai-corpus-cross-validation.md` confirmed this on 43 of 46
drifts). The fix is in the *ground-truth*, not the model: walk each
AI label image, confirm visually whether the label shows a country
marking, and rewrite the ground-truth `country_of_origin` to null
when it doesn't. ~50 images × 30 s = ~25 min of manual review.

### A6. Add a Gemini 3 Flash benchmark — **in progress**
`T6f = gemini-3-flash-preview` added to the bench techniques. Result
file lands as `benchmarks/results/<iso>-T6f.{json,md}` once the run
completes. If T6f beats T6 on either accuracy or latency at acceptable
cost, switch `MODEL_PRIMARY`. If T6 still wins, document the
comparison and leave the choice.

### A7. Optional: Stroke Width Transform (SWT) verification for the Gov-Warning prefix
Today the bold subscore uses Tesseract OCR-bbox column-mean stroke
length (`src/lib/validation/bold-size.ts`). A second-opinion SWT
pass over the cropped prefix region — using opencv via WASM or a
hand-rolled SWT — would corroborate or contradict the OCR-based
metric. Material accuracy gain on the bold subscore specifically;
~half a day to wire.

### A8. Two-pass verification for borderline cases
When the orchestrator returns REVIEW and the user is willing to wait,
offer a "verify again with a stronger model" button that re-runs the
single image through Gemini 3.1 Pro Preview (T6c). Costs $4 / 1k vs
$0.25 but is opt-in and only for borderline cases.

## UX & accessibility

### U1. Mobile information density — **DONE 2026-05-12**
The Gov-Warning subscore block is now wrapped in a `<details>`
element on `sm:hidden` (under 640 px). Auto-opens when the GW
status is not PASS so reviewers still see the failure breakdown
without an extra tap; collapses cleanly on PASS to shave ~400 px
of mobile scroll. Desktop (≥ sm) keeps the always-visible flat
list.

### U2. FAIL sample's defect should be readable from the thumbnail — **DONE 2026-05-12**
SampleAffordance now renders a "Look for: ..." italic hint under each
non-PASS sample (`title-case warning prefix` for the FAIL sample;
`borderline bold stroke width on prefix` for the REVIEW sample). The
full `expectedNote` is in the `title` tooltip and aria-describedby
sibling. PASS sample stays uncluttered.

### U3. Per-component producer breakdown auto-expands on REVIEW/FAIL — **DONE 2026-05-12**
SingleResult now adds `open` to the `<details>` element when
`cmp.status !== "pass"`. Reviewer sees the component breakdown
immediately on any non-pass producer verdict; PASS stays collapsed.

### U4. Keyboard navigation
Tab through the idle screen, the form, the result. Likely-broken
spots: the `<details>` disclosure for "About this prototype",
focus-trap on file pickers, focus-return after dropping back to
idle.

### U5. Color-blindness test
StatusChip uses red/green/yellow with icon + word redundancy (✓ ✗ ⚠).
Confirm with a deuteranopia simulator that PASS / FAIL are
distinguishable on the chip background alone.

### U6. Per-image cost surface — **DONE 2026-05-12**
SingleResult now renders `≈ $0.00025 per call` next to the latency
in the header. Hover tooltip extrapolates to "≈ $0.25 per 1,000
labels" for procurement conversations. Cost lookup via static table
keyed on modelId so it works for fallback / Pro tiers too.

## Reliability & ops

### R1. Tighter `/api/warmup` semantics — **DONE 2026-05-12**
`/api/warmup` now warms the Gemini SDK alongside Tesseract (parallel
runs, max wall-clock). Deliberately does NOT make a real Gemini API
call — that would burn tokens for marginal gain. The SDK
module-load + client construction is the actual cold-start cost, and
that's what we now eagerly pay during warmup. Saves ~150 ms on the
first user call.

### R2. Per-request `X-Request-Id` header — **DONE 2026-05-12**
`src/middleware.ts` runs on every `/api/*` request. Reads inbound
`X-Request-Id` (allowlist: 128 chars max, `[A-Za-z0-9_-]`) or
generates a UUIDv4. Echoes back on the response. `/api/verify`
error responses also include the id in the JSON body so users can
copy it from a toast. Tests in `src/tests/middleware-request-id.test.ts`.

### R3. CSV export for batch results — verify it works end-to-end
Documented but I haven't manually verified it produces useful output
for a 100-row batch. Quick Playwright e2e.

### R4. Rate-limit on every state-changing endpoint, per-endpoint bucket — **DONE 2026-05-12**
Two real gaps were closed:
- `/api/application/parse` had NO rate-limit at all on audit. Fixed
  in this file: `app-parse:${ip}` bucket at 60/min, separate from
  `verify:` and `extract:`. Regression test in
  `src/tests/api-application-parse-rate-limit.test.ts`.
- `/api/verify/batch` ALSO had no rate-limit on audit (caught
  during sibling Claude session merge). Fixed: `batch:${ip}` bucket
  at 60/min, separate from the other three. Bacc632 consolidation.

All four mutating endpoints now have distinct per-IP buckets so
exhausting one cannot starve the others. Buckets sweep stale entries
after 60 minutes idle.

### R5. Vercel Pro upgrade — document the deltas — **DONE 2026-05-12**
Added `docs/DEPLOYMENT.md` §7a: Hobby → Pro table covering function
timeout, memory, concurrency, bandwidth, team seats, analytics, log
retention. Includes a 3-step upgrade procedure that does NOT require
code changes (vercel.json memory/timeout settings can stay or bump).

## Tests & validation

### T1. Playwright e2e against the LIVE URL — **DONE 2026-05-12**
`.github/workflows/e2e-live.yml` runs Playwright against the live
URL nightly (04:00 UTC) and on `workflow_dispatch`. Picks up
deployment regressions (CSP, missing env, vendor key expiry) that
local tests can't see. Not on every PR — would burn vendor $$.

### T2. Per-component compareProducer tests for spoofing — **DONE 2026-05-12**
Both edge cases now in `src/tests/producer-spoof-resistance.test.ts`:
"rejects implicit-USA when state='ME' but name+city+street name a
Mexican producer" + "rejects EXPLICIT 'MEXICO' even when every
other component matches declared US producer". Suite is at 10 tests.

### T3. Visual regression test on the result panel
Playwright `screenshot` + `toMatchSnapshot` on a fixed sample so
UI regressions land in CI not in user reports.

### T4. Stratified bench-result test — **DONE 2026-05-12**
`src/tests/bench-stratum-sanity.test.ts` loads the newest
`benchmarks/results/*.json` summary and walks every technique's
stratified table. Fails CI if any (beverage_type × condition × field)
stratum returns 0 % over n ≥ 20. Skips cleanly when no bench result
exists (fresh clone).

## Documentation

### D1. Update README with the 170-image headline — **DONE 2026-05-12**
README now shows 93.8 % on 170 images (1,169 fields), with 95.8 % ID
/ 88.4 % OOD split and 5.1 % GW FN-rate. Source result file pointer
updated. T6f comparison cross-ref added.

### D2. Add a "Failure mode catalog" doc — **DONE 2026-05-12**
`docs/FAILURE-MODES.md` enumerates 7 failure clusters (F1-F7) plus
3 orchestrator safeguards and 3 limits. Each entry names the
pattern, why it happens, what the orchestrator does, and the headline
impact in % / count.

### D3. OpenAPI spec for /api/verify and /api/extract — **DONE 2026-05-12**
`docs/openapi.yaml` covers /api/verify, /api/extract, /api/application/parse,
/api/verify/batch (+ stream), /api/health, /api/warmup, /api/debug/last,
and /api/queue. Includes DeclaredFields, FieldComparison,
GovernmentWarning, and VerifyResponse schemas. Documents the
X-Request-Id contract, rate-limit headers, and the debug-bearer auth
scheme.

### D4. SECURITY.md — **DONE 2026-05-12**
`/SECURITY.md` covers: reporting channel + 48hr SLA window, threat
model (untrusted inputs, no auth, ephemeral data lifecycle),
mitigations in place (8 categories: network/transport, SSRF, upload
validation, prompt-injection, rate-limiting, producer-comparator
hardening, observability, debug surfaces), known unmitigated gaps,
and per-vendor data handling notes.

### D5. CONTRIBUTING.md — **DONE 2026-05-12**
`/CONTRIBUTING.md` covers setup (incl. Windows), repo layout, 3
common extensions (new vision provider, new ground-truth corpus, new
test mode), the prompt-hash contract, CI gates, and code
conventions. Cross-references ARCHITECTURE.md, MODEL-SELECTION.md,
FAILURE-MODES.md, SECURITY.md.

### D6. Diagrams refresh
The mermaid diagram in README still shows the old 4-contender mental
model. Update to show the auto-fallback path + the application-parse
flow.

## Polish (low priority)

### P1. PWA manifest + service worker
Offline-friendly install on a reviewer's phone. ~2 hours.

### P2. Per-route bundle analysis
`npm run build` reports route sizes. Check `/api/verify` isn't
bloated; consider tree-shaking the unused vision adapters.

### P3. Better empty-state for the Review Queue
Today: "No labels currently waiting on human review." A second
sentence ("Items appear here when the verifier needs a human
judgment on borderline cases") would clarify.

### P4. Dark-mode visual sweep
Re-test every screen in dark mode. The StatusChip tuning is good;
the form errors and the new "verified via backup" banner haven't
had a dark-mode visual review since the copy changed.

### P5. Performance: lazy-load the dark-mode init script
Currently inline in `<head>` as a pre-paint script. The script body
is ~600 bytes — moving it to a separate critical-CSS-style hash
wouldn't actually save bytes. Skip.

### P6. Per-image bench result archiving
Old bench result JSONs accumulate in `benchmarks/results/`. Add a
git-lfs config or a script to compress old runs.

### R6. Resumable batch stream — **NEW (caught 2026-05-12 evening)**
`MAX_BATCH=1000` accepts any batch up to 1000 items, but the SSE
stream lives inside ONE Vercel function invocation capped at 60 s
(Hobby) or 300 s (Pro). With CONCURRENCY=8 and ~3 s/call:
- Hobby plan: ~160 items finish before the function times out.
- Pro plan: ~800 items.
Submitting a 1000-batch on Hobby therefore loses ~840 items mid-
stream. The UI's "connection dropped" banner currently invites the
user to reconnect, but reconnecting RESTARTS the stream from
item 0 — replaying work that already completed and billed.

Fix scope (~3-4 hours): persist per-item completion state in
`batch-store.ts` (already keyed by item index), have the SSE stream
skip items where `status === "done" || status === "error"` on
reconnect. Client-side: tag SSE messages with a stable sequence
number so the UI can dedupe replayed events.

For the take-home submission window, document the realistic ceiling
in the route docstring (done) and recommend batches ≤ 100 for the
prototype demo URL.

## Out of scope (acknowledge but won't do)

- Custom CNN training (no labelled data).
- Self-hosted Qwen2.5-VL inference (engineering scope blowup).
- Integration with TTB COLA system (explicit non-goal per brief §9).
- Authentication / user accounts (explicit non-goal per brief §9).
- Multi-tenant support (explicit non-goal per brief §9).
- Persistent storage of submitted images (explicit non-goal per brief §9).
- Mobile-native app (explicit non-goal per brief §9).
