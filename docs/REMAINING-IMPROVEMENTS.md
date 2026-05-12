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

### A2. Calibrate `REVIEW_CONFIDENCE_THRESHOLD` against the 170-image data
Currently 0.55 — set by guess. Should sweep 0.30–0.95 against the
per-image outcomes captured in
`.review/t6-routine-per-image.json` (15 images) and a fresh 170-image
pass with per-field confidence logged. Pick the threshold that
minimises (false-positive-defers × 3 + missed-wrong-PASSes × 5) per
the pre-registered weights in `docs/PROJECT-TODO.md`.

### A3. Re-run T6 with the new comparators to refresh the headline
`compareCountry` was relaxed for US-domestic labels (REVIEW instead
of FAIL). A fresh `npm run bench -- --corpus test-data-combined
--technique T6 --trials 1` would show the new orchestrator-level
accuracy. The per-field scorer treats REVIEW as wrong so the bare
field-level number won't move, but the orchestrator-level
PASS-FAIL-REVIEW breakdown will (fewer FALSE FAILs, more REVIEWs).

### A4. Capture per-image outcomes during the formal bake-off
`benchmarks/run.ts` only emits the aggregated `TechniqueSummary`
today. Per-image outcomes get lost. A small change to write
`<run-id>-per-image.json` alongside the summary would mean we can
re-analyse without rerunning the bench.

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

### U1. Mobile information density
The result page on a phone (<480px) stacks 1500-2000px of content
before the "Verify another label" CTA. The previous UX agent
flagged this; today's fix collapses `conf 0.92` numbers on phones
but the Gov-Warning subscore + per-field rows still stack
vertically. A `<details>` collapse on mobile for the Gov-Warning
breakdown would compress this further.

### U2. FAIL sample's defect should be readable from the thumbnail
Currently the FAIL sample (Mercer's Reserve Vodka, title-case prefix)
shows a thumbnail too small to read the prefix casing. A hover-card
or always-visible "Look for: title-case warning prefix" annotation
would tell the reviewer what to look for *before* they click.

### U3. Per-component producer breakdown is opt-in via `<details>` — make it visible by default if there's a REVIEW
Today: if `producer.status === "review"` the user sees "1 producer
component did not match" but has to click "Per-component breakdown"
to see which one. Auto-expand when status is REVIEW or FAIL.

### U4. Keyboard navigation
Tab through the idle screen, the form, the result. Likely-broken
spots: the `<details>` disclosure for "About this prototype",
focus-trap on file pickers, focus-return after dropping back to
idle.

### U5. Color-blindness test
StatusChip uses red/green/yellow with icon + word redundancy (✓ ✗ ⚠).
Confirm with a deuteranopia simulator that PASS / FAIL are
distinguishable on the chip background alone.

### U6. Per-image cost surface
The result panel today shows latency but not USD-per-call. Adding
a tiny "≈ $0.0003" pill would tell a TTB ops person what a batch
of 1,000 would cost — useful for procurement conversations.

## Reliability & ops

### R1. Tighter `/api/warmup` semantics
Today warmup races Tesseract init against an 8s budget. Add a second
warmup call that also pings Gemini (1-token prompt) so the function
is fully warm on the first user call. Saves ~1s on cold-start
verifies.

### R2. Per-request `X-Request-Id` header
Add a UUID per request, log it in `console.warn` lines and surface
it in the response so a user reporting "this failed" gives the
operator something to grep with. ~20 lines of middleware.

### R3. CSV export for batch results — verify it works end-to-end
Documented but I haven't manually verified it produces useful output
for a 100-row batch. Quick Playwright e2e.

### R4. Rate-limit on `/api/application/parse` symmetric to `/api/verify`
Currently the application-parse route shares the rate-limit bucket
but the bucket key is per-IP not per-endpoint. Verify the current
behaviour is what we want; document.

### R5. Vercel Pro upgrade — document the deltas
Today we're on Hobby (30s timeout, 2GB memory). Pro lifts both. The
README mentions cold-start can flirt with the 30s cap; an "upgrade
path" section in DEPLOYMENT.md would help a future operator decide.

## Tests & validation

### T1. Playwright e2e against the LIVE URL
The `e2e/` specs target `http://localhost:3100`. Add a CI mode that
targets `https://label-verify-six.vercel.app` (already set in
playwright.config via `E2E_BASE_URL`). Run on every PR.

### T2. Per-component compareProducer tests for spoofing
Already have spoof-resistance tests (committed). Add edge cases:
- Producer with extracted.state="ME" but extracted.name="Mexican
  Tequila Co" — should fail country (no corroborator).
- Producer with all components matching except country printed as
  "MEXICO" — should fail country.

### T3. Visual regression test on the result panel
Playwright `screenshot` + `toMatchSnapshot` on a fixed sample so
UI regressions land in CI not in user reports.

### T4. Stratified bench-result test
The bench harness produces stratified data. Add a sanity test that
verifies no stratum returns 0% over n=20+ (which would suggest a
systematic data error rather than model error).

## Documentation

### D1. Update README with the 170-image headline
README currently says "93.3% on 140 images" — refresh with 93.7%
on 170 once the country-comparator-fixed T6 rerun completes.

### D2. Add a "Failure mode catalog" doc
The bake-off identifies specific failure clusters (country_of_origin
on photo labels, gov-warning paraphrase on clean labels). A short
doc enumerating these, why they happen, and what the orchestrator
does about each would help a reviewer understand the system's
limits.

### D3. OpenAPI spec for /api/verify and /api/extract
For anyone embedding the verifier programmatically. ~1 hour to write.

### D4. SECURITY.md
A `SECURITY.md` at the repo root tells a reviewer where to report
issues + lists the mitigations already in place. Bonus: GitHub
auto-links to it from the security tab.

### D5. CONTRIBUTING.md
For self-hosters who want to add a new vision provider, a new
ground-truth corpus, or a new test mode. Walks through
`benchmarks/techniques.ts`, the prompt hash contract, and the
CI gates.

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

## Out of scope (acknowledge but won't do)

- Custom CNN training (no labelled data).
- Self-hosted Qwen2.5-VL inference (engineering scope blowup).
- Integration with TTB COLA system (explicit non-goal per brief §9).
- Authentication / user accounts (explicit non-goal per brief §9).
- Multi-tenant support (explicit non-goal per brief §9).
- Persistent storage of submitted images (explicit non-goal per brief §9).
- Mobile-native app (explicit non-goal per brief §9).
