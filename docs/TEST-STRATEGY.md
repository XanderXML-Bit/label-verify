# Test Strategy

How the project is tested, what corpus the benchmark runs against, what statistical conventions the bench applies, and which test surfaces catch which class of regression.

## 1. Test surface inventory

| Surface | Count | Runtime | Purpose |
|---|---:|---|---|
| Vitest specs (unit + integration) | 949 across 90 files | ~10 s (`npm test`) | Pipeline correctness: matchers, validators, scorers, route handlers, schemas, CLI argument parsing. |
| Playwright E2E specs | 9 spec files | ~30–60 s with `npm run dev` (`npm run test:e2e`) | Browser-driven user-flow validation. Covers idle screen + samples, application-input prefill, batch autopair, form validation, friendlyError mapping, upload rejection, sample retry, API status banner, extract-only. |
| Benchmark harness | `benchmarks/run.ts` (T-variant tournament) + `bin/labelverify-bench.ts` (cross-pair) | ~5 min routine, ~30 min full bake-off, ~15 min cross-pair | Accuracy + latency measurement on the corpus. |
| CLI smoke tests | 3 test files (`cli.test.ts`, `cli-web.test.ts`, `bench-cross-pair.test.ts`) | included in Vitest | Subprocess-level argument parsing, help, exit-code semantics for all three CLIs. |
| Production smoke | `.github/workflows/post-deploy-smoke.yml` | < 1 min on every push to `main` | `/api/health` and a single live verify against the deployed URL. |

## 2. Test corpus

170 images on disk in `test-data-combined/`. Two strata:

- **Synthetic SVG (n = 90).** Vector-rendered from deterministic templates. The Government-Warning failure modes are hand-controlled and catalogued in [`government-warning-cases.md`](government-warning-cases.md).
- **Photo-realistic AI-generated (n = 80).** Codex `image_gen` renders across two batches (50 + 30). Stress-cases include Government-Warning paraphrase, photo-quality degradation (perspective, glare, lowlight, occlusion, motion blur, aged paper, shrink-wrap, curved substrate), bilingual EN/ES warnings, and novel beverage categories (hard cider, sake, hard kombucha, RTD cocktail, mead, malt seltzer).

Each image has a ground-truth JSON with the seven declared fields and four Government-Warning compliance booleans (`present`, `text_matches_regulation`, `prefix_all_caps`, `prefix_bold`, `meets_size_minimum`). Ground-truth provenance is documented in [`CORPORA.md`](CORPORA.md).

A parallel `test-data-combined/declared-wrong/` directory carries one programmatically-perturbed payload per ground-truth file (brand swap, ABV +2.0 pp, class swap to a non-alias sibling, ×2 net_contents, country swap). Regenerated deterministically by `npm run bench:perturb`.

## 3. Ground-truth format

```json
{
  "id": "syn-beer-0042",
  "source": "synthetic",
  "image": "test-data/labels/syn-beer-0042.png",
  "degradations": ["perspective:15deg", "lowlight:0.6"],
  "beverage_type": "beer",
  "label_face": "front",
  "container_size_ml": 355,
  "fields": {
    "brand_name": "Stone's Throw Brewing",
    "class_type": "India Pale Ale",
    "class_category": "beer",
    "abv_percent": 6.4,
    "net_contents": { "value": 12, "unit": "fl_oz" },
    "producer": "Stone's Throw Brewing Co., 14 Mill St, Asheville, NC 28801, USA",
    "country_of_origin": "USA",
    "government_warning": {
      "present": true,
      "text_matches_regulation": true,
      "prefix_all_caps": true,
      "prefix_bold": true,
      "meets_size_minimum": true
    }
  },
  "gov_warning_case": null,
  "notes": "Standard front label, well-lit, no glare."
}
```

The `gov_warning_case` field uses the case taxonomy in [`government-warning-cases.md`](government-warning-cases.md) (`C1_PREFIX_TITLE_CASE`, `T1_WORD_SUBSTITUTION`, `B1_PREFIX_NOT_BOLD`, etc.). `null` means the warning is fully compliant.

## 4. Benchmark harness

Two complementary runners:

### 4.1 Model tournament — `benchmarks/run.ts`

```
for each technique in techniques:
  for each image in corpus:
    repeat N trials:
      record { latency, raw_output, parsed_fields, errors }
    score parsed_fields vs ground_truth
  aggregate accuracy, P50/P95 latency, error rate, cost
write results to benchmarks/results/<iso>.json
emit Markdown summary
```

Variants are registered in `benchmarks/techniques.ts`. The tournament supports a smoke mode (`--smoke`, 20 images, 1 trial), a routine mode (`--routine`, 15 images, 3 trials), and a full bake-off (`--bake-off`, all images, 3 trials).

### 4.2 Cross-pair benchmark — `bin/labelverify-bench.ts`

Runs every image × {correct ground-truth, perturbed wrong-declared} through the production `verifyLabel` orchestrator. Reports pass-rate on correct, fail-or-review rate on wrong, P50/P95 total + vision latency, and per-`gov_warning_case` breakdown. See [`CLI.md`](CLI.md) for invocation.

## 5. Scoring rules

- **Exact-match fields** (Government-Warning text, country, class/type): binary pass/fail after Unicode normalization, smart-quote folding, dash variant folding, whitespace collapse, and non-printing-space folding (NBSP, narrow NBSP, en-quad through hair-space, medium math space, ideographic space, zero-width space, BOM).
- **ABV**: `pass` if `|measured − declared| ≤ tolerance(class_category)`. Per-class tolerances are TTB-style absolute percentage points: beer ±0.3 pp, wine ±0.5 pp under 14 % ABV / ±1.0 pp at or above 14 %, distilled spirits ±0.15 pp.
- **Net contents**: `pass` if values match after unit conversion within `max(1.5 ml, 0.5 %)` tolerance. "12 fl oz" matches "355 ml" within ~0.1 ml.
- **Brand name**: normalize (Unicode-fold, lowercase, strip punctuation, collapse whitespace), then `pass` if Levenshtein ratio ≥ 0.92 AND token-set ratio ≥ 0.85. The token-set backstop prevents single-edit short brands from sneaking past Levenshtein.
- **Producer / address**: structured per-component comparison (street, city, state, postal_code, country). A single mismatched component routes to REVIEW rather than collapsing the whole field to FAIL. US-domestic inference (label prints state code but no explicit "USA") is gated on a strict 2-letter state code plus at least one corroborating component.
- **Country**: synonym table across 7 languages and 25 countries (`src/lib/matching/country.ts`). French `RÉPUBLIQUE FRANÇAISE` matches `France`; Japanese `日本` matches `Japan`.
- **Class / type**: alias table with two tiers — `SAFE_ALIASES` (auto-PASS for known interchangeable terms like Whisky/Whiskey) and `REVIEW_ALIASES` (route to REVIEW for terms that are commonly used interchangeably but are distinct under TTB classification, e.g. Lager / Pilsner).
- **Government Warning** has four subscores:
  - `text`: normalized exact match against the canonical §16.21 body.
  - `caps`: prefix is all-caps after Unicode-fold (including small-caps codepoints).
  - `bold`: prefix stroke width ≥ 1.4 × body stroke width via the classical-CV stroke-width transform (`src/lib/validation/bold-size.ts`). Ambiguous middle (1.2–1.4×) returns `review`. Falls back to the model's `prefix_appears_bold` flag at advisory 0.6 confidence when OCR cannot locate the prefix.
  - `size`: prefix glyph height ≥ §16.22 minimum (1 mm small container / 2 mm large), bbox → mm via declared net contents.
  - Aggregate: worst-of across the four subscores.

## 6. Statistical reporting

Every benchmark run reports:

- **Wilson 95 % CI** on every accuracy point estimate.
- **Stratified accuracy table** — per (beverage type × image condition × field). The reviewer sees a column for "low-light spirits Government-Warning" rather than only the aggregate.
- **Per-technique-pair McNemar's test** — for any "A is better than B" claim in the decision record, the p-value is reported. Two techniques inside each other's CI are reported as a tie.
- **Per-field false-negative rate for Government Warning**, separately from overall accuracy. FN = "passed a non-compliant label" — the regulator-relevant direction.
- **Per-stratum breakdown** (SVG synthetic vs photo-realistic AI), reported separately rather than pooled.

The bench scorer treats a `REVIEW` outcome the same as a `FAIL` when computing accuracy — only an unambiguous PASS counts as correct. This is a deliberately strict measurement convention. In the production orchestrator, REVIEW is a routed-to-human verdict with a regulation-citing reason, so the headline metric understates the operator-level outcome (see [`FAILURE-MODES.md`](FAILURE-MODES.md) §F1).

## 7. Ground-truth validation

For the photo-realistic stratum (which was not generated from a deterministic template), ground truth was cross-validated by an independent vision-model oracle pass (Gemini 3.1 Pro Preview) and a four-sub-agent visual audit. The cross-validation results were recorded internally during corpus build (2026-05-12) and informed the GT-correction pinned in `src/tests/wave31b-gt-correction-pin.test.ts`. Human-resolved ground truth is the source of truth where automated cross-checks disagree.

Borderline-bold cases are excluded from the bold-detection subscore (they still score on text match, caps, and size). Encoding a confused answer in the ground truth would silently grade a flawed technique as wrong, or a confused technique as right.

## 8. E2E coverage

Playwright specs under `e2e/`:

| Spec | Covers |
|---|---|
| `idle-and-sample.spec.ts` | Idle-screen affordances; dark-mode toggle persistence; three sample buttons end-to-end. |
| `application-input-flow.spec.ts` | Image + JSON application-file upload → form prefill → Verify; image + Skip → extract-only. |
| `batch-autopair.spec.ts` | Drop 2 images + 2 stem-matched application JSONs → autopair detection → inline batch result. |
| `form-validation.spec.ts` | Empty form, ABV bounds, net-contents validation reach the user. |
| `error-mapping.spec.ts` | 429 / 413 / 415 / 503 / 504 / 500 / network failure all surface friendly copy, not raw HTTP. |
| `upload-rejection.spec.ts` | `.exe` / `.gif` / app-only rejection paths surface inline errors. |
| `sample-retry.spec.ts` | Sample 500 → "Retry this sample" → succeeds on second attempt. |
| `api-status-banner.spec.ts` | `/api/health` notes surface in the page-load banner; healthy → banner hidden. |

E2E specs use `page.route(...).fulfill(...)` mocks for the verify endpoints so the suite does not depend on a real vision API key, runs offline-safe, and is deterministic in CI.

## 9. CLI test surfaces

| File | Covers |
|---|---|
| `src/tests/cli.test.ts` | Operator CLI (`bin/labelverify.ts`) — help, arg parsing, samples, health (offline commands only; network-touching paths are exercised by the bench and live smoke). |
| `src/tests/cli-web.test.ts` | Web-app driver CLI (`bin/labelverify-web.ts`) — help, arg parsing, samples (offline), plus source-shape regression guards that lock the `/api/application/parse` and `/api/verify` response field names. |
| `src/tests/bench-cross-pair.test.ts` | Perturbation helper (`perturb()`) determinism + mutations-are-distinct + null-country handling, plus bench CLI help and `GOOGLE_API_KEY` exit-1 guard. |

## 10. Continuous validation

- Every push to `main` triggers `.github/workflows/ci.yml` (typecheck + lint + test + production build) and `.github/workflows/post-deploy-smoke.yml` (`/api/health` + one live verify against the deployed URL).
- Routine bench (`npm run bench:routine`) is the recommended local sanity check before any prompt or model change. Results land in `benchmarks/results/<iso>.md`.
- Full bake-off (`npm run bench:bakeoff`) is run on demand; the result table is committed to the repo and cross-referenced from [`MODEL-SELECTION.md`](MODEL-SELECTION.md) §4.

## 11. Out of scope

- Adversarial labels designed to fool the model.
- Live load tests beyond the interactive batch ceiling derived from the Vercel Hobby plan's 60-s function cap.
- Real submitted COLA labels. The corpus is an in-house bench; field-validation against real submissions is the natural next step before drawing field-deployment conclusions.

## 12. Reproducibility

- The synthetic corpus is generated by `scripts/generate-corpus.ts` and `scripts/generate-corpus-v2.ts` with deterministic seeds. The perturbation generator (`scripts/perturb-declared.ts`) is hash-deterministic per ground-truth `id`.
- Every benchmark result records the model version, prompt hash, and per-image cost.
- `npm run bench`, `npm run bench:routine`, `npm run bench:cross-pair`, and `npm test` all work from a clean clone with only `GOOGLE_API_KEY` (and optionally `OPENAI_API_KEY` for the fallback) in `.env.local`.
