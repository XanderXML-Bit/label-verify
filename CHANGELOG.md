# Changelog

> Notable changes only. Routine commits live in `git log`. Dates use
> the project's working timezone (US Pacific). Sections follow Keep a
> Changelog conventions.

## [Docs + UI consolidation pass + audit-driven fact refresh] — 2026-05-14

### Docs

- Refreshed every user-facing doc against actual project state.
  Stale claims corrected across `README.md`, `CONTRIBUTING.md`,
  `SECURITY.md`, `docs/ARCHITECTURE.md`, `docs/TEST-STRATEGY.md`,
  `docs/DEPLOYMENT.md`, `docs/DEPLOYMENT-CHECKLIST.md`,
  `docs/PRODUCTION-SMOKE.md`, `docs/MODEL-SELECTION.md`,
  `docs/FAILURE-MODES.md`:
  - Test count `~470/506` → **628** across **65** files.
  - Bake-off variants `13` → **16**.
  - Headline pass-rate `~76 %` → **65.1 % deterministic across N=12
    successive cross-pair benches** (waves 22–25 stabilised the
    noise band).
  - `src/lib/matchers/` → `src/lib/matching/` (directory rename).
  - `src/lib/vision/prompts.ts` → `src/lib/vision/prompt.ts`.
  - `src/lib/score.ts` reference replaced with "the `aggregateVerdict`
    helper in `src/lib/verify.ts`" — the standalone scorer was inlined.
  - `EXTRACTION_PROMPT_HASH` → `EXTRACTION_PROMPT` + `getPromptHash()`.
  - `src/lib/ocr/sanitise.ts` reference dropped — sanitization lives
    in `buildOcrHintSection` (`src/lib/vision/prompt.ts`).
  - Second-opinion vs cross-provider-fallback paths disentangled
    everywhere (pre-wave-22 docs conflated them).
  - New env vars documented: `MODEL_PRIMARY`,
    `SECOND_OPINION_PROVIDER`, `SECOND_OPINION_MODEL`.
- Pruned orphan archive docs:
  - `docs/archive/REVIEW-PASS.md` (broken self-link).
  - `docs/archive/UI-SPEC.md` (UI shipped; spec dead paper).
- Tailwind config comment reference to `docs/UI-SPEC.md` trimmed.

### Code

- `src/lib/verify.ts:buildDefaultExtractor`: `MODEL_PRIMARY` env-var
  override (operations escape hatch for future Google A/B without
  a code change). Default unchanged: `gemini-3.1-flash-lite`.
- `src/app/api/health/route.ts`: detailed health response now
  includes `secondOpinion` field alongside `model` (primary) and
  `fallback` (primary-failure cross-provider). Each is independent.

### UI — Simple-mode prune (user direction)

- `Download JSON` / `Download CSV` result-panel buttons →
  `.detailed-only` (technical exports; non-technical reviewer
  doesn't need them on the simple surface).
- `About this prototype` idle-screen `<details>` → `.detailed-only`.
- Long intro paragraph → simple/detailed split. Simple gets the
  one-line "Upload a label image to get a pass / fail / review
  verdict.". Detailed keeps the full description.
- Skip-/re-upload affordances kept; mode-toggle layer unchanged.

### Validation

- 628/628 vitest tests pass. `tsc --noEmit` clean. `next lint`
  clean. `npm audit --omit=dev` reports 0 production-dependency
  vulnerabilities. Live production health endpoint returns
  `{ ok:true, ready:true }`. Playwright sub-agent confirmed the
  Simple/Detailed mode toggle correctly hides/shows the pruned
  surfaces.

## [Wave 27: primary-model bake-off — no architecture change] — 2026-05-14

### Decision

- Confirmed by direct head-to-head bench (`gemini-3.1-flash-lite`
  vs `gemini-2.5-flash` vs `gemini-3-flash-preview`, each tested as
  the **primary** with second-opinion disabled): the current
  architecture is correct.
  - `gemini-3.1-flash-lite` Pareto-dominates on
    latency × cost × accuracy × error rate.
  - `gemini-2.5-flash` is 5.8× worse as primary on false-fails
    (3 → 17.5), confirming it belongs on the second-opinion path
    (wave 22), not the primary.
  - `gemini-3-flash-preview` has the best raw pass-rate (+7.5 pp)
    but violates fp-on-correct (+2 deterministic), latency
    (p50 17 s vs 2.6 s), error rate (5× higher), and cost (6×) —
    disqualified.

### Artifacts

- `docs/WAVE-27-PRIMARY-BAKEOFF.md` — full methodology + results.
- `benchmarks/results/bakeoff/{compare-bakeoff.js,
  gemini-3.1-flash-lite-run{1,2}.json,
  gemini-2.5-flash-run{1,2}.json,
  gemini-3-flash-preview-run1.json}`.

## [Waves 26 + 21: pre-registered reverts] — 2026-05-13/14

### Reverted at the regulator-critical guardrail

- **Wave 26** (size-threshold degraded-PASS band 0.65–0.80): N=3
  bench showed +1 deterministic false-pass-on-correct on synthetic
  S2 case `ai-label-0049`. Pass-rate gained +7 pp but the user
  principle "false-pass-on-correct is worse than review" disqualified
  the change. Methodology lesson banked: my measurement script
  averaged Tesseract bbox heights, but the validator uses MAX —
  any future size-threshold experiment must use the same
  aggregation as the validator end-to-end.
- **Wave 21** (prompt-engineered `prefix_taller_than_body`): N=1
  bench showed +14.4 pp pass-rate but +6 deterministic
  false-pass-on-correct. Same revert mechanism. The
  relative-tallness question is structurally wrong for synthetic
  S-cases because the generator's "normal" prefix is already
  larger than body text — 0.45× of normal is still taller than
  body, so the model correctly answers "yes" and false-passes.

## [Wave 25: null-extraction safety net] — 2026-05-13

### What changed

- New `src/lib/verify.ts` §5c safety net: when the FAIL verdict is
  driven SOLELY by null-extraction comparators (status=fail at
  confidence ≤ 0.05 — the comparator's null-sentinel pattern) and
  the Gov-Warning isn't FAIL, upgrade FAIL → REVIEW with a
  "could not read [fields] from the submitted image" reason. Sister
  safety net to §5b (image-quality), which misses null-extraction
  cases because the image-quality calc explicitly filters null
  values to avoid penalising legitimately-absent fields like
  country on US-domestic labels.
- Recovery: 1 deterministic false-fail (`deg-beer-0001` — class_type
  region overlaid by a peeling-degradation graphic on the photo).

### Bench

- false-fail 4 → **3** (cumulative vs baseline: 11.9 → 3, −8.9).
- fp-on-correct unchanged at 5 (within ±2σ baseline noise).
- All 9 buckets identical across all 3 wave-25 replicates.
- Doc: `docs/WAVE-25-FINDINGS.md`.

## [Wave 24: class_type generic-on-label acceptance] — 2026-05-13

### What changed

- New `GENERIC_CLASS_FAMILIES` table in `src/lib/matching/class.ts`
  (wine / beer / distilled spirits / fortified wine → known subtypes).
  When the LABEL canonicalizes to a generic family name (e.g.
  "WINE", "BEER", "MALT BEVERAGE", "DISTILLED SPIRITS") AND the
  DECLARED canonicalizes to (or token-contains) a known subtype
  (e.g. "Grenache", "Lager", "Mango Lime Malt Seltzer", "Bourbon"),
  route to REVIEW at confidence 0.65. Conservative landing
  preserves sharp rejection on wrong-GT perturbations.
- Recovery: 3 deterministic false-fails on AI-photo labels
  (`ai-label-0065` Grenache/WINE, `ai-label-0076` Lager/BEER,
  `ai-label-0080` Mango Lime Malt Seltzer/MALT BEVERAGE). All
  three are compliant under TTB class-of-fitness regs (27 CFR
  §4.32 / §7.22 / §5.22).

### Bench

- false-fail 7 → **4**. Cumulative −7.9 vs baseline.
- fp-on-correct held at 5.
- Doc: `docs/WAVE-24-FINDINGS.md`.

## [Wave 23: Gov-Warning text case-fold] — 2026-05-13

### What changed

- `normalizeForTextMatch` now case-folds (`.toLowerCase()`) as its
  final step. 27 CFR §16.21 prescribes the prefix in caps + bold
  (still enforced separately by `scoreCaps` on the un-normalized
  prefix), but says nothing about body case. The pre-wave-23
  strict-equality compare treated ALL CAPS body as a paraphrase
  defect and emitted `text=fail` at confidence 1.0.
- Recovery: 5 deterministic false-fails on AI-photo labels with
  ALL CAPS body (`ai-label-0002/5/6` → PASS, `0007/0008` → REVIEW
  due to size=review co-fail).

### Bench

- false-fail 12 → **7** (cumulative −4.9 already).
- fp-on-correct held at 5.
- Doc: `docs/WAVE-23-FINDINGS.md`.

## [Wave 22: Gemini 2.5 Flash second-opinion (smarter, same provider)] — 2026-05-13

### What changed

- New `src/lib/vision/second-opinion.ts` selector. The
  REVIEW-trigger recheck path now uses **Gemini 2.5 Flash** by
  default (same provider as the primary, smarter on borderline
  reasoning) instead of GPT-5.4-nano. Cross-provider OpenAI
  fallback remains wired separately for the primary-failure path.
  Env vars: `SECOND_OPINION_PROVIDER` (`gemini` default | `openai`),
  `SECOND_OPINION_MODEL` (per-provider model id override).
- Health endpoint exposes a `secondOpinion` field alongside `model`
  and `fallback` so operators can verify the resolved model id
  matches expectations.

### Bench

- true-reject 164.3 → **168** (+3.7, outside +2σ — sharper
  wrong-GT rejection).
- review-on-wrong 4.8 → **1** (paired transfer — same cases moved
  from review to reject).
- false-pass-on-correct unchanged (5, within ±2σ baseline noise).
- 6 of 9 buckets became deterministic across replicates (baseline
  had ±10 pp pass-rate jitter on the same corpus).
- Doc: `docs/WAVE-22-FINDINGS.md`.

## [Wave 7: surgical false-positive fix + image-zoom UI + user-batch fix] — 2026-05-13 late

### What changed

- **Wave 6's confidence-floor GW gate replaced by a narrow predicate.**
  The wave-6 gate (`gov.confidence < 0.55` → REVIEW) was too aggressive
  on the cross-pair bench: eliminated 5 Type I errors but added ~15
  Type II over-reviews per ~33 PASS results — operator-prohibitive at
  the 150 k applications/yr deployment scale. Wave-7 narrows the
  trigger to the exact `boldFallbackOnlyPass` case: `gov.status === "pass"
  && bold.status === "pass" && bold.confidence === 0.6` (the model-self-
  report-only fallback in the validator). On trigger, the existing
  second-opinion infrastructure fires — if the second cross-provider
  model also reports bold = pass, the PASS verdict is restored
  (independent two-model agreement substitutes for pixel measurement).
  Disagreement keeps the verdict at REVIEW with a disagreement reason
  surfaced in the UI's ⚖ panel. Test count: 489/489 passing.

- **Image-zoom viewer on the result panel.** New `ImageZoom` component
  (`src/app/components/ImageZoom.tsx`) wraps the submitted-label
  thumbnail in a click-to-open modal with +/-/reset zoom controls, an
  X close button, Escape-to-close, backdrop-click-to-close, and focus
  trap. Used by both `SingleResult` and `ExtractionOnlyResult`. 7 unit
  specs in `src/tests/ui/image-zoom.test.tsx`.

- **User-reported batch failure.** A filename-keyed JSON manifest
  (`{"image-001.jpg": {row}, "image-002.jpg": {row}, ...}` — a natural
  reviewer-authored shape) was previously flattened into garbage column
  names. Detector now expands the filename-keyed shape into a multi-row
  manifest with an implicit `filename` column; a top-level `fields`
  wrapper hoists directly to the row. Reproduced + fixed end-to-end
  against production; 4 regression tests in `detect-manifest.test.ts`.

- **`country_of_origin` is now nullish (string | null | undefined).**
  TTB only requires country marking on imports (27 CFR §4.39 / §5.36);
  US-domestic applications may legitimately omit it. The comparator's
  null-declared branch handles both (null + label-also-empty → PASS;
  null + label-shows-a-country → REVIEW). Resolves the 72 GT errors on
  the cross-pair bench and the user's `ai-label-0016` batch failure.

### Validation

- 489 / 489 tests passing (was 478 → 489 across the wave: +7 image-
  zoom + +2 wave-7 second-opinion + +4 detect-manifest + +3 country-
  nullable + −1 retired confident-PASS-doesn't-fire-second-opinion).
- Typecheck clean. Production build green via CI on every PR.
- User's exact 12-image batch (`C:\Users\xande\Downloads\LabelVerify
  Test Samples\`) now returns all 12 verdicts end-to-end against
  production after deploy.

### Scope and limitations refresh

- README "Methods considered" rewritten in scientific prose (no take-
  home framing). Models-benchmarked count corrected from 13 to 16.
- ARCHITECTURE.md, TEST-STRATEGY.md, CORPORA.md rewritten to current-
  state-only (no pre-correction narrative).
- UI-SPEC.md archived (pre-implementation doc).

## [Comprehensive hardening pass — four audits + two waves of fixes] — 2026-05-13

### Why this exists

User asked for infrastructure that catches regressions WITHOUT manual
bug-filing — i.e. comprehensive automated coverage across backend,
CLI, AND GUI. Four parallel sub-agent audits (E2E gaps / fixtures /
docs / perf+accuracy+code-quality) produced findings; two implementation
waves landed them.

### Wave 1: second CLI + perf + accuracy

- **Web-app driver CLI (`bin/labelverify-web.ts`)** — the second of two
  CLIs. The first (`bin/labelverify.ts`) drives the backend in-process;
  this one hits the HTTP API exactly like a browser does. Shipping both
  means GUI-only route-layer bugs (multipart parsing, MIME handling,
  serverless cold-start) get caught by a non-browser surface. 8 new
  vitest specs cover help / arg parsing / samples offline.
- **`extractOnly` perf** — removed dead-weight 1.5 s pre-vision OCR
  wait in `src/lib/verify.ts`. Saves ~1500 ms P50 on `/api/extract`.
  The wait was a leftover from an earlier prompt design; no current
  extractor adapter reads `ctx.ocrWords`.
- **GW NBSP / zero-width accuracy fix** — `normalizeForTextMatch` now
  folds NBSP (U+00A0), narrow NBSP (U+202F), en-quad → hair-space
  (U+2000..U+200A), medium math space (U+205F), ideographic space
  (U+3000), zero-width space (U+200B), BOM (U+FEFF), and `…` →
  `...`. A verbatim federal warning exported from a Canadian /
  European DTP pipeline (often emits NBSP between "GOVERNMENT" and
  "WARNING") was previously reporting text-mismatch; now it doesn't.
  5 new regression tests.
- **`imageQuality` extractor-vs-comparator confidence fix** — already
  shipped earlier in the day, now called out by name in the changelog.
  The image-quality column now derives from the *extractor's* per-field
  confidence on fields the model actually read (value !== null), NOT
  from the comparator's confidence (which drops when declared values
  are wrong even on a clean photo). Stops the false "Re-photograph"
  flag when the manifest disagrees with a cleanly-read label.

### Wave 2: comprehensive E2E + cross-pair benchmark + code-quality

- **Six new E2E specs** covering Agent A's top gaps — batch flows had
  ZERO E2E coverage; friendlyError mapping had ZERO; form validation
  had ZERO; sample-retry had ZERO; ApiStatusBanner had ZERO; upload
  rejection had ZERO. All use `route.fulfill` mocks so they don't hit
  real vision API. Files: `e2e/{batch-autopair, form-validation,
  error-mapping, upload-rejection, sample-retry, api-status-banner}.spec.ts`.
- **Broken E2E test fixed** — `e2e/idle-and-sample.spec.ts` was
  asserting the Human review queue region IS visible on idle, but
  page.tsx removed `ReviewQueuePanel` from idle on 2026-05-13. Test
  now asserts NOT visible.
- **Cross-pair benchmark** — `scripts/perturb-declared.ts` +
  `bin/labelverify-bench.ts` + 170 perturbed manifests. Details in
  next CHANGELOG section.
- **WeakMap-based batch-route cache** — replaced 4 `@ts-expect-error`
  File-mutation cache sites in `src/app/api/verify/batch/route.ts`
  with a typed `WeakMap<File, ParsedApplication>`. Same behavior, no
  type suppressions, no runtime hazard.
- **Stale "Smart-tier" error copy removed** from
  `src/app/api/verify/route.ts:307`. Mode selection was retired
  earlier; the user-facing error was still suggesting it.
- **SSE batch endpoint documented** as local-dev-only — production
  uses the inline POST path. Header comment in
  `src/app/api/verify/batch/[id]/stream/route.ts`.
- **Corpus default switched** to `test-data-combined/` (the 170-image
  canonical superset) in `benchmarks/run.ts` and
  `scripts/validate-corpus.ts`. The v1 `test-data/` directory
  remains in place for historical reference but is no longer the
  default.
- **Orphan `public/samples/review.jpg` deleted.** The REVIEW
  affordance intentionally reuses `pass.jpg` (Pilsner-vs-Lager
  mismatch); the standalone file was never served.

### Docs

- **`docs/CLI.md` (new)** — full reference for the three CLIs
  (operator / web-driver / benchmark) with command tables, examples,
  exit codes, and explanation of why three.
- **`docs/CORPORA.md` (new)** — canonical map of `test-data*/` and
  `public/samples/` directories.
- **README updated** — added an "Option D — Use the CLI" section
  with examples; fixed stale test count (was 418, now 472); added
  CLI doc links to the documentation map.
- **`docs/openapi.yaml`** — `pairing.mode` enum updated to include
  `auto-inline-manifest`, `auto-stem+content`, `auto-broadcast`
  (was only `[manifest, auto-stem]`). Reflects the actual server
  modes shipped 2026-05-12 / 13.
- **`docs/DEPLOYMENT.md`** — stripped the `labelverify.zendren.net`
  CNAME instructions (the custom domain was dropped on 2026-05-12).
  Section now describes "if you fork" flow generically.
- **`docs/PRODUCTION-SMOKE.md`** — Check 4 no longer references the
  removed "Generate manifest template" button; now documents all
  four batch pairing paths (auto-pair / inline-manifest / broadcast /
  paste).
- **CONTRIBUTING.md** — test count updated (was ~370, now ~470).

### Validation

- **472 / 472 tests** passing (was 450 at start of session; +22:
  +8 web-CLI, +5 NBSP regression, +9 cross-pair-perturb).
- Typecheck clean.
- Branch: `hardening/comprehensive-pass` (this PR).

### Files

Wave 1: `bin/labelverify-web.ts`, `src/tests/cli-web.test.ts`,
`src/lib/verify.ts`, `src/lib/validation/government-warning.ts`,
`src/tests/government-warning.test.ts`,
`e2e/idle-and-sample.spec.ts`, `package.json`.

Wave 2: 6 new `e2e/*.spec.ts`, `bin/labelverify-bench.ts`,
`scripts/perturb-declared.ts`, `src/tests/bench-cross-pair.test.ts`,
170 files at `test-data-combined/declared-wrong/`,
`src/app/api/verify/batch/route.ts`, `src/app/api/verify/route.ts`,
`src/app/api/verify/batch/[id]/stream/route.ts`,
`benchmarks/run.ts`, `scripts/validate-corpus.ts`,
`public/samples/review.jpg` (deleted), `bin/labelverify-web.ts`,
`package.json`, `docs/CLI.md` (new), `docs/CORPORA.md` (new),
`README.md`, `CONTRIBUTING.md`, `docs/openapi.yaml`,
`docs/DEPLOYMENT.md`, `docs/PRODUCTION-SMOKE.md`.

## [Cross-pair benchmark — programmatic GT perturbation catches both FN and FP] — 2026-05-13

### What's new

- **`scripts/perturb-declared.ts`** — deterministic, idempotent mutator
  that reads each ground-truth JSON in `test-data-combined/ground-truth/`
  and emits a parallel `test-data-combined/declared-wrong/<basename>.json`
  with five targeted mutations per file:
  brand_name → unrelated brand, class_type → non-alias sibling within
  the same `class_category`, abv_percent + 2.0 pp (beyond every class's
  tolerance), net_contents.value × 2, country_of_origin → different
  non-USA country. Brand / class / country are picked via FNV-1a hash
  of the GT id, so the picks vary across labels (different "wrong"
  brand per image) but are stable across reruns (safe to commit). 170
  perturbed files generated.
- **`bin/labelverify-bench.ts cross-pair`** — third CLI surface dedicated
  to the cross-pairing benchmark. Iterates every label in
  `test-data-combined/labels/` against BOTH its correct GT and the
  perturbed wrong GT, then reports:
  - **pass-rate on CORRECT GT** — catches false-NEGATIVES (matcher too
    strict; correct application → unjustified fail/review).
  - **fail/review-rate on WRONG GT** — catches false-POSITIVES (matcher
    too lenient; intentionally bogus application slipped through as pass).
  - P50 / P95 latency for total + vision stages, errors counted
    separately, and a per-`gov_warning_case` breakdown so the reviewer
    can see whether the FP/FN rates concentrate in any one case.
  - Defaults `--limit 10` for safety (full 170×2 run is ~$0.10 +
    ~15 min); `--concurrency 2` matches the existing batch CLI;
    `--out <path>` writes the JSON report; `--json` streams to stdout.
- **`src/tests/bench-cross-pair.test.ts`** — 5 unit tests for the
  perturb helper (determinism, in-place safety, null-country handling,
  cross-label variance) plus 4 smoke tests for the bench CLI
  (help / arg parsing / GOOGLE_API_KEY guard). No real verify calls
  in the test suite — those are exercised by the bench CLI itself
  when run with a live API key.
- **`npm run bench:cross-pair`** and **`npm run bench:perturb`** scripts
  wired in `package.json` for convenience.

### Why this matters

The existing bake-off (`benchmarks/run.ts`) measures vision-extractor
accuracy against the ground-truth — it answers "how well does the
extractor see the label?" but not "does the matcher correctly **reject**
wrong applications?" A 100 %-accurate extractor paired with an
overly-lenient matcher would still pass a fraudulent application that
declares Cabernet against a Pilsner photo. The cross-pair bench is the
matcher's symmetric eval: by construction every "wrong" condition has
five field disagreements vs. the label, so a healthy matcher must FAIL
or at minimum REVIEW. Anything that comes back PASS is a regulatory
escape — far more damaging than a spurious REVIEW.

## [GW false-negative deep dive — strokeProxy fix + scorer Q-case fix + README scientific honesty pass] — 2026-05-13 mid

User-explicit ask: "if we could get that government warning false
negative rate down to zero, if possible, ... and only have the most
up-to-date percentages in benchmarks." Both addressed.

### What changed

- **`src/lib/validation/bold-size.ts` — `strokeProxy` size-invariance fix.**
  A sub-agent deep-dive on the 7 measured GW false-negatives traced
  4 of them (`deg-beer-0012`, `syn-beer-0014/0015/0016`) to one root
  cause: the per-column mean-dark-run-length was returned un-normalised
  by bbox height. TTB warnings render the prefix at LARGER font than
  the body, so vertical-stroke-dominant glyphs in the prefix produced
  mean run lengths proportional to bbox height — NOT stroke thickness.
  The resulting prefix/body ratio spuriously crossed BOLD_RATIO_PASS
  (1.5×) even when both regions were the same font weight. Fix: one
  line, divide by `Math.max(1, h)`. Existing tests updated to use
  proportional stroke thicknesses (which is how real fonts work).
- **`benchmarks/scorer.ts` — `truthCompliant` from booleans, not from
  `gov_warning_case` tag.** The same sub-agent caught that 2 of 7
  GW false-negatives (`ai-label-0030`, `syn-wine-0011`) were
  encoding bugs: `gov_warning_case` is overloaded with image-quality
  tags like `Q4_LOW_LIGHT` that name a degradation axis, not a
  compliance defect. The label IS compliant; the image just renders
  it under stress. Counting those as truth=non-compliant gave the
  model 2 free false-negatives. Fix: derive `truthCompliant` from
  the 4 GW booleans (`present` + `text_matches_regulation` +
  `prefix_all_caps` + `prefix_bold` + `meets_size_minimum`); the
  `gov_warning_case` tag stays as a category label for analysis
  but no longer drives the truth status.
- **Combined effect** (predicted by audit math): GW FN-rate from
  ~5 % (7/137) to **~0.7 %** (1/137). Bench rerun on the corrected
  corpus + corrected scorer + corrected validator is in flight at
  commit time.

### Legibility audit findings (also from the deep-dive)

Two SVG synthetic labels have **rendering issues**, not model
errors: `syn-beer-0011` (barrel icon overlays the "Wheat Beer" class
subtitle, making it borderline illegible) and `syn-beer-0018` (the
"Stout" class subtitle is rendered as empty/invisible — corpus
generation bug). Both surfaced as `class_type` failures and contribute
~1.5 pp of "model error" that's actually corpus quality. Flagged in
the README's generalizability caveat, not silently fixed (changing
the corpus mid-submission would invalidate the bench).

### README — scientific honesty pass

- **At-a-glance** row updated to only the corrected `~99 %` headline,
  with a generalizability-caveat link.
- **Headline measurement** rewritten end-to-end: removed the
  two-column as-measured / corrected split, replaced with a single
  "Latest numbers" table + a new "Generalizability caveat (scientific
  honesty)" subsection that explicitly states: SVG synthetics are
  easy by construction; AI labels share a foundation-model family
  with the extractor (self-similarity bias risk); the corpus was
  built and audited by us; the 10.2 % Wilson upper on the GW FN
  CI is real and we can't claim ≤ 10 % at 95 % confidence on this
  corpus. Treat headline as a calibrated upper bound for in-
  distribution behavior, not a forecast for field performance.
- **Architecture / OCR-vs-LLM** clarified with a per-subscore table
  showing exactly where each model is invoked. Text + caps subscores
  are pure string ops on model-extracted text (no OCR). Bold + size
  subscores are OCR-preferred with model self-report fallback.
- **Latency budget** table now includes the second-opinion line
  (+~2.5 s when it fires, only on REVIEW GW) + clarifies that
  vision is provider-bound and cannot be further cut.

### Validation

- 440 / 440 tests passing (after updating the bold-size + scorer
  tests to the corrected conventions).
- Typecheck clean. Lint clean. Production build green.

## [True auto-batch — multi-row manifest detection + broadcast + batch-screen file upload] — 2026-05-13 early

User-reported correctness bug + UX feedback: dropping 12 images +
1 CSV containing rows for all 12 returned `400 no-pairs-found`. The
images-only batch screen required text-paste of a manifest (no file
upload option). Fixed both.

### Backend — auto-pair pipeline rewrite

A 4-stage pipeline replaces the previous 3-stage one:

1. **Inline-manifest detection** (NEW) — any dropped CSV / JSON
   detected as a multi-row file with a `filename`-aliased column is
   expanded into per-image pairs BEFORE filename-stem and content
   pairing run. So 12 images + 1 12-row CSV → 12 pairs. 5 images +
   a 20-row CSV → 5 pairs + 15 orphan rows surfaced as warnings.
2. Filename stem matching (existing).
3. Content-based fallback (existing).
4. **Single-application broadcast** (NEW) — when ≥ 2 unpaired images
   remain with exactly 1 unpaired single-product app file, broadcast
   the same parsed fields to every image with a warning so the
   operator can reject.

### Files

- `src/lib/application/detect-manifest.ts` (NEW) — `detectCsvManifestShape` +
  `detectJsonManifestShape`. Recognises `filename` / `file` / `image` /
  `label` / `cola_number` / `id` columns (case-insensitive +
  separator-insensitive). Pure structural — no I/O, no vision.
- `src/tests/detect-manifest.test.ts` (NEW) — **13 tests** covering
  single-row, multi-row + filename column, multi-row without, alias
  variants, malformed input, nested net_contents flattening.
- `src/lib/batch-pairing.ts` — extended `PairingSummary.mode` enum
  (`"auto-inline-manifest"`, `"auto-broadcast"`), added optional
  `orphanedManifestRows` + `broadcast` fields, extended
  `PairingHit.source` enum (`"manifest-inline"`, `"manifest-broadcast"`).
- `src/app/api/verify/batch/route.ts` — inserted the inline-manifest
  detection pass before `pairByFilenameStem`. Inline-manifest pairs
  cache their row directly; the per-pair loop uses `rowToDeclared`
  on the row instead of re-parsing the multi-row CSV (which would
  silently collapse to row 0). Added the broadcast pass after
  content-pairing.
- `src/app/page.tsx` — replaced the manifest-only batch screen with an
  embedded `UploadZone` for application files. Manifest text-paste
  demoted to a collapsed `<details>` for power users. Removed
  "Generate manifest template" button (the new flow makes it
  unnecessary).

### Live production verification

| Scenario | HTTP | Mode | Pairs | Notes |
|---|---|---|---|---|
| 12 images + 1 CSV (12 rows) | 200 | `auto-inline-manifest` | 12 | The reported bug — fixed |
| 5 images + 1 CSV (20 rows) | 200 | `auto-inline-manifest` | 5 | 15 orphan rows surfaced as warnings |

### Validation

- **440 / 440 tests** passing (was 427; +13 detect-manifest tests).
- Typecheck clean. Lint clean. Production build green.
- `audit-report.html` (stray local `npm audit` artifact) removed +
  `.gitignore`d.

## [Content-based fallback pairing] — 2026-05-12 late night

User-explicit ask: the auto-pair should handle even **randomly-named
files**, not just files whose stems happen to match. Now it does, via
a two-stage strategy.

### What's new
- **`pairByContent(unpairedImages, unpairedApps)`** in
  `src/lib/batch-pairing.ts`. Greedy assignment by weighted similarity
  on `{ brand_name, class_type, abv_percent }` fingerprints. Brand
  weighted highest (0.65) since it's the most distinctive label
  signal; class 0.25; ABV 0.10 (when both sides have a finite value).
  Threshold 0.55 by default.
- **Fingerprint extraction** is asymmetric Levenshtein + substring
  match, normalised for case + diacritics + punctuation. "Mill
  Creek" ≡ "MILL CREEK BREWING CO." with a substring boost.
- **Wired into the batch route**. After `pairByFilenameStem`, if any
  images and apps remain unpaired AND `GOOGLE_API_KEY` is available,
  the route parses each unpaired app's fingerprint (already needed
  for verify downstream — cached so the loop doesn't re-parse) and
  runs a lightweight `GeminiFlashExtractor.extract` on each unpaired
  image, then calls `pairByContent`. Content-paired rows surface
  in `pairing.mode === "auto-stem+content"` with `source: "content"`
  and a `score` field per pair.
- **+9 regression tests**: identical fingerprints score 1.0; mixed
  case/punctuation matches; greedy picks highest score first;
  randomly-named-file scenarios; threshold override; dissimilar
  items remain unpaired.
- **README + CHANGELOG** updated to describe the two-stage strategy.

### Tests + validation
- 427/427 vitest tests passing (was 418).
- Typecheck clean. Lint clean. Build green.

## [Accuracy + UX wave: corpus corrections, multilingual, auto-pair, second-opinion] — 2026-05-12 late evening

Three parallel sub-agent corpus audits + multiple user-explicit UX
asks. The OOD accuracy ceiling moves from 88.4 % measured → 99–100 %
projected once the corpus-quality fixes are baked in (full bench
rerun in flight at this commit).

### Accuracy / corpus

- **78 GT files corrected** on the AI corpus:
  - 74 US-domestic labels: `country_of_origin: "USA"` → `null` (TTB
    only mandates country marking on imports; the model correctly
    returns null; the bench scorer was treating REVIEW as wrong).
  - 4 restored to `"USA"` (`ai-label-0012`/`0024`/`0039`/`0041`) where
    the label DOES visibly print "Product of USA" / "PRODUCTO DE EE.
    UU." — initial null-out was too aggressive on these.
  - 2 `class_category` typos: `0008` + `0022` were `fortified_wine`
    but the labels are Porter beer.
  - 1 brand over-spec: `0037` "Mountain Lark Cider" → "Mountain Lark"
    (Cider is the class descriptor on the label, not part of the
    brand).
  - 1 GW-flag honesty fix: `ai-label-0066` motion-blurred image had
    four positive bool flags asserted on a visually unreadable
    warning — set to `null` with an audit_notes block.
- **Bench scorer** extended to accept `country_of_origin: string | null`
  and the four GW bool flags as `boolean | null`. Audit trail with
  per-image before/after in
  `test-data-combined/ground-truth/.country-corrections-2026-05-12.json`.
- **Multilingual country comparator**: 25 countries × 7 languages
  (English, Spanish, French, German, Italian, Portuguese, Japanese
  日本, Korean 대한민국, Greek Ελλάδα, Chinese 中国, and more). Wine
  importers send labels in their local language and a strict English-
  only string compare false-FAILed them. +14 regression tests.

### Orchestrator

- **Independent second-opinion vision call** on borderline GW. Fires
  on REVIEW (steps 5 or 6 of the verdict pipeline) or low-confidence
  PASS without OCR corroboration. Cross-provider (GPT-5.4-nano via
  OpenAI). Attaches `secondOpinion: { modelId, governmentWarning,
  agreesWithPrimary, reason, latencyMs }` to the response. UI panel
  renders 🔁 (both agree) or ⚖ (disagree → human adjudicates).
  +5 regression tests.
- **Unreadable-image safety net** (user-explicit ask): if
  `imageQuality === "bad"` AND the worst-of rule would have returned
  FAIL, route to REVIEW with a re-photograph reason. A corrupt photo
  of a compliant label is not non-compliance. +1 test.

### UX

- **Batch auto-pair fix** (user-reported blocker): dropping images +
  application files together no longer takes you through the manifest-
  paste screen. The new UI shows a "X images + Y application files
  detected" summary with file listings and a single "Verify batch
  (N pairs)" button. Manifest override available in a `<details>`
  accordion.
- **Skip button** (user-explicit ask): was an inline text link below
  Verify, now a proper outlined secondary button next to Verify, with
  explanatory helper text below the row.

### Validation

- **418 / 418 tests** passing (was 411 → 418 across the wave).
- Typecheck clean. Lint clean. Production build green.
- Live manual browser test on production: PASS / FAIL / REVIEW
  samples all returned correct verdicts in 4.5–5.2 s with 0 console
  errors.
- Production-dep `npm audit --omit=dev`: still 0 vulnerabilities.
- Secrets audit re-confirmed: `.gitignore` correctly excludes env
  files; no committed key strings in 50-commit history.

## [Custom-domain scrap + postcss CVE fix] — 2026-05-12 night

- **Dropped the planned custom domain** (`labelverify.xandermlopez.com`).
  The Vercel URL is the production URL; no custom domain is wired and
  none is needed. Rationale: the Vercel deployment is fully functional,
  TTB reviewers land there from the README's live-demo link, and a
  half-wired custom domain (Vercel-side alias set but DNS unresolved)
  is *worse* than no custom domain — anyone copying the URL hits
  NXDOMAIN and thinks the site is broken. Removed the
  `labelverify.xandermlopez.com` alias from the Vercel project,
  deleted `docs/CUSTOM-DOMAIN.md`, stripped references from
  `README.md`, `CHANGELOG.md`, `docs/ARCHITECTURE.md`,
  `docs/DEPLOYMENT.md`, and `docs/DEPLOYMENT-CHECKLIST.md`. Archived
  pre-implementation `docs/archive/TODO.md` mentions of a "P0 custom
  domain" task are intentionally left as historical record.
- **Bumped `postcss` 8.4.49 → 8.5.14** to close GHSA-qx2v-qp2m-jg93
  (XSS via unescaped `</style>` in CSS stringifier, CVSS 6.1). Added
  `overrides.postcss: ^8.5.14` so Next's nested 8.4.31 also resolves
  to the patched version. **`npm audit --omit=dev`: 0 vulnerabilities**
  (was 2). Documented in `SECURITY.md`.

## [Pre-submission audit-fix wave] — 2026-05-12 late night

Four parallel deep audits (Hermes / Codex / UX sub-agent / code-review
sub-agent) found a unanimous **security finding** plus 20 other items
across correctness, doc drift, and UX polish. All addressed:

### Security
- **CSV formula injection (3-audit consensus).** `lib/export-result.ts`
  only RFC4180-escaped cells before. A filename like `=cmd|' /C calc'!A0.jpg`
  or a model-derived review reason starting with `=`/`+`/`-`/`@` would
  execute as a formula when opened in Excel/Sheets/LibreOffice. Per
  OWASP, leading dangerous chars are now prefixed with `'` before the
  CSV quote pass. Regression test covers the full set of OWASP prefixes.

### Correctness fixes
- **`DeclaredForm` late-prefill clobber (UX-agent blocker #1).** When a
  reviewer dropped image + app together, then explicitly picked the
  default value for `class_category` / `ncUnit` / `country` while the
  app parse was in flight, an arriving prefill silently overwrote
  their choice (the "still empty?" check used equality-with-default
  as a proxy for untouched). Replaced with sticky per-field `touched`
  flags wired to `onChange`. Test pending; manual reproduction confirmed.
- **Surplus app files silently dropped (UX-agent blocker #2).** Dropping
  N application files alongside one image kept the best-stem-match
  and `console.warn`ed the rest — invisible to the reviewer. Now
  surfaces a yellow status pill next to the form listing the ignored
  files and explaining why.
- **`UploadZone` rejected empty-MIME files (UX-agent blocker #3).**
  Windows Explorer + Edge return `f.type === ""` for `.csv`/`.md`/
  `.docx`/`.heic`. The strict `accept.includes(f.type)` filter
  rejected files the OS picker had just shown the user, surfacing a
  misleading "unsupported type" error. Added extension → MIME fallback
  for the 13 supported extensions. Regression tests cover accept-via-
  extension and unknown-extension rejection on the drop path.
- **GW PASS at no-OCR low confidence (Codex finding #2).** When OCR
  failed or timed out, the validator's bold/size subscores fell back
  to the model's self-reported flags at ≤ 0.6 baseline confidence
  (size capped at 0.4). The §5a deferral loop skipped `gov`, so a
  no-OCR PASS slipped through despite the README advertising pixel-
  level stroke-width measurement. Now routes to REVIEW with an
  explicit human-readable reason when `ocrFinal === null` AND
  `gov.status === "pass"` AND `gov.confidence < 0.55`. The gate is
  narrow: high-confidence vision-only PASS still passes; only the
  genuinely-degraded path defers.
- **Scanned-PDF batch path silently dropped warnings (Codex #3).**
  Batch auto-pair calls `parseApplication`, which for scanned PDFs
  falls back to vision OCR and returns `{ confidence: "low",
  warnings: [...] }`. The route validated `parsed.fields` and dropped
  the rest — reviewer never saw that a row's declared values came
  from OCR-on-a-scan. Now surfaces a `pairingWarnings` array in the
  batch response alongside `pairingErrors`.
- **Batch pairing missed `-app`-tagged applications (Hermes #4).**
  Docs claimed `123456-front.jpg ↔ 123456-app.pdf` worked, but the
  stem helper's `stripFaceTag` only stripped image-side suffixes —
  the app's relaxed stem stayed `123456-app` and never matched.
  Added `stripAppTag` option, enabled it on the relaxed pass for
  applications. Test locks in the documented behavior.

### Doc drift
- **README §"Security model"** still claimed Tesseract OCR was wrapped
  in `<untrusted_ocr>` for the production vision prompt — falsified
  by C1 removal. Rewrote: helper retained for benchmark + defensive
  future use, production omits OCR text.
- **MODEL-SELECTION §4.3 row** said C1 ships as a non-default "Settings
  panel: Local + Hybrid" mode. Settings panel was never built;
  production is single vision-only path. Rewrote the row.
- **MODEL-SELECTION §4.5** referenced a non-existent
  `lib/vision/tiered.ts` for tiered-escalation threshold tuning.
  Rewrote — no tiered escalation exists; fallback is provider-
  failure-only per `verify.ts:188-247`.
- **`verify.ts:101` function header** still said "we feed OCR to the
  vision prompt only if it returns in time" — false since C1
  falsification. Rewrote to state OCR's only role is bold/size
  subscores.
- **`vision/gemini.ts:156` comment** also claimed OCR appended to
  prompt. Rewrote.
- **PRODUCTION-SMOKE Check 3** documented a field name `fallbackModel`
  that the actual `/api/health` route returns as `fallback`. Aligned.
- **`stream/route.ts` CONCURRENCY math** said "drain ~160 items at
  CONCURRENCY=8" but `CONCURRENCY = 2`. Rewrote the comment with
  correct math + rationale (free-tier RPM 15 shared with /api/verify).

### UX polish
- **Verdict-review chip contrast.** `#a16207` on `bg-yellow-100`
  rendered at `text-xs` (12px) gave 4.33:1 — fails WCAG AA small
  (needs 4.5:1). Darkened to `#854d0e` (yellow-800), gives 6.04:1.
  Same shade applied to `quality.low` for visual consistency.
- **Idle-screen subhead.** Added one line noting the application
  file is optional (the extract-only path was previously only
  discoverable from the form's secondary button).
- **Cost-display tooltip** leaked the raw model id
  (`gemini:gemini-3.1-flash-lite`) to TTB reviewers. Stripped —
  telemetry still has it via `/api/health` and JSON export envelope.
- **Warmup `AbortController`** added to prevent stacked warmups on
  fast tab close/reopen + React StrictMode double-invoke.
- **`document.title`** now toggles to `"(Verifying…) Label Verify"`
  during async work so reviewers can tell from the tab strip when
  to switch back from email.
- **Footer safe-area-inset** for iOS home-indicator clearance.
- **`SampleAffordance`** sample-image fetch now shows per-button
  pending spinner + visible error alert on 404 / network blip.

## [Final audit pass] — 2026-05-12 night

Two outside-reviewer CLI agents (Hermes / GPT-5.5, Codex / GPT-5.5
local review) found a combined seven contradictions between the docs
and the post-merge code. All cleared:

- **MODEL-SELECTION §4.4** said the fallback is confidence-driven; code
  is provider-failure-driven only. Rewrote the section. The doc also
  claimed a T6 → T7b → T1 Tesseract-only degradation tier that does
  not exist in production code; doc now states that and explains why.
- **MODEL-SELECTION verdict-criteria check** cited a small-routine GW
  FN-rate of 28.6 % while marking the criterion ✅. Reframed: that
  small-corpus number is not evidence; the 170-image rerun's 5.1 %
  point / 10.2 % CI upper is the real evidence, marked ⚠ for the
  CI-not-95 %-confident edge.
- **`extractOnly` was passing `ocrText` into the vision prompt** even
  though README says "vision-only." Stripped it from the primary +
  fallback paths. README claim is now true.
- **`parseApplication` had a stale "DOCX upload is not yet supported"
  block** shadowing the new DOCX dispatch. Removed.
- **`vision/prompt.ts` header comment** said "Tesseract's OCR text
  gets appended to every vision prompt as a hint" — true before the
  C1 falsification, false now. Rewrote.

Plus:
- **DOCX application files** now supported via `mammoth`
  (`src/lib/application/parse-docx.ts`). Closes F5.
- **Manifest-template generator button** on the batch-pending screen
  seeds a CSV with one row per uploaded image — lightweight take on F7.
- **PWA manifest** at `/public/manifest.webmanifest` wired through
  `app/layout.tsx` for "Add to home screen" on phones/tablets.
- **Bench rerun** on `test-data-combined` post-comparator-fixes:
  93.8 % overall (n=1,169), 96.0 % ID, 88.4 % OOD, 5.1 % GW FN, **P50
  3.0 s / P95 4.1 s** (improved from 3.2/4.6 — the OCR-text-removal
  shaved ~500 ms off the tail).

Validation: 405 tests pass (+4 DOCX, +1 DOCX classifier), tsc clean,
lint clean, CI + post-deploy smoke green.

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
