# Test Strategy

> How we generate test labels, store ground truth, run benchmarks, and prove
> the system works.

## 1. Why This Matters

Without a corpus of labels with **known correct field values**, we cannot:

- Compare extraction techniques (`APPROACH.md`).
- Detect regressions when we change prompts or models.
- Make any defensible claim about accuracy to the evaluator.

The corpus is the foundation. We build it first.

## 2. Corpus Composition Targets

Minimum **100 labels** for the v1 benchmark. Composition reflects the
narrower 4-contender benchmark (see `APPROACH.md` §2) — with 4 techniques
not 13, 100 labels gives ≈ ±5 pp Wilson CI per cell, which is defensible.

| Axis | Targets |
|------|---------|
| Beverage type | 35 beer, 30 wine, 25 spirits, 10 fortified wine / RTD |
| Label face | 60 front, 30 back (Gov Warning lives on back for most spirits), 10 neck/side |
| Image quality | 35 clean, 25 angled / perspective-skewed, 15 low-light, 10 glare, 10 partial occlusion, 5 curved-bottle/wrap distortion |
| **Government Warning correctness** | **40 compliant, 40 non-compliant (per `government-warning-cases.md` taxonomy), 20 missing entirely** — flipped from the first-draft split because the false-negative rate (passing a non-compliant label) is the dangerous direction for a regulator and needs adequate samples to estimate |
| Brand name complexity | 35 single-word, 30 multi-word, 20 with apostrophes/punctuation, 15 with stylized caps |
| ABV range | Beer 3.5–8 %, wine 11–14.5 %, spirits 35–55 %, fortified 17–22 % |
| Container size | 25 small (≤ 237 ml), 75 large (> 237 ml) — drives §16.22 type-size minimums |

Synthetic edge cases are intentional: a model that only handles clean photos
fails R4. Real-world COLA submissions are not uniform.

## 3. How We Generate Labels

We don't need real submissions. We generate ours, three ways:

### 3.1 Synthetic Renders (primary, ~70 labels)

- HTML/CSS templates parameterized by JSON spec → rendered to PNG via
  Puppeteer / Playwright.
- Templates cover the common label layouts (front, back, neck).
- Each template randomizes: brand name (from a curated faux-brand list),
  ABV, net contents, country, address, warning text.
- Ground-truth JSON is emitted *as part of generation* — by construction, it
  matches the rendered pixels.

### 3.2 Degradation Pipeline (~30 labels)

Take a clean synthetic label, apply transforms:

- Perspective warp (homography matrix) → "photographed at an angle."
- Gaussian + Poisson noise → "phone camera."
- Brightness curves → "low light" / "glare patches."
- Partial mask → "thumb covering corner."

Ground truth is unchanged from the source render. We log which transform
was applied, so we can compute per-condition accuracy.

### 3.3 Public-Domain Real Labels (10 labels, reported as out-of-distribution)

A small set of real beverage labels (sourced from TTB's public COLA
registry / Public COLA Registry disclosures) for sanity-checking that we
haven't overfit to synthetic artifacts.

**Reported as OOD, not folded into the headline number.** This is the
honest read: 10 labels cannot statistically defend a "we work on real
labels" claim. They can show direction. The benchmark write-up reports a
*separate column* for real-label accuracy, with a footnote stating
n = 10 and the implied CI.

Ground truth is **hand-transcribed by the author**, then verified by a
top-tier vision model, **then diffed**. Where the human and the model
disagree, the human resolves. Where they *agree*, we still spot-check
(LLMs can share correlated errors on stylized text — see §5).

If we land time for a v2 corpus expansion, the priority is more real
labels (target 25–30) rather than more synthetic. P1 in `TODO.md`.

## 4. Ground Truth Format

One JSON file per image, same basename:

```json
{
  "id": "syn-beer-0042",
  "source": "synthetic",
  "image": "test-data/labels/syn-beer-0042.png",
  "degradations": ["perspective:15deg", "lowlight:0.6"],
  "fields": {
    "brand_name": "Stone's Throw Brewing",
    "class_type": "India Pale Ale",
    "abv": 6.4,
    "net_contents": { "value": 12, "unit": "fl_oz" },
    "government_warning": {
      "present": true,
      "exact_match": true,
      "prefix_bold": true,
      "prefix_caps": true
    },
    "producer_name_address": "Stone's Throw Brewing Co., 14 Mill St, Asheville, NC 28801, USA",
    "country_of_origin": "USA"
  },
  "notes": "Standard front label, well-lit, no glare."
}
```

## 5. Ground-Truth Validation

For real labels and any high-stakes edge case, we cross-check ground truth
with a *separate, advanced* model (e.g., Claude Opus or GPT-4o on the full
high-resolution image). Any disagreement is human-resolved before the label
enters the benchmark set.

**Caveat (the correlated-error trap):** large vision-language models share
training corpora and fail in correlated ways on the same hard cases —
stylized type, foil, ambiguous bold weights. If both human and model
agree, the ground truth is still wrong in that subset. Mitigations:

- **100 % human-authored ground truth on the 10 real-label OOD set** —
  the model is *validator*, never *author*.
- **Spot-check pass on synthetic ground truth** — the same author re-checks
  20 % of synthetic entries a day later. Catches transcription mistakes
  from the generator.
- **Borderline-bold cases are not in the benchmark.** If even the author
  cannot confidently call the prefix bold or not-bold by eye, we exclude
  the label from the bold-detection sub-score (it can still score on text
  match and caps) rather than encode a confused answer.

Without this discipline the answer key silently grades a flawed technique
as "wrong" or a wrong technique as "right." We will not let that happen.

## 6. Benchmark Harness

`benchmarks/run.ts`:

```
for each technique in techniques:
  for each image in corpus:
    repeat 3:
      record { latency, raw_output, parsed_fields, errors }
    score parsed_fields vs ground_truth
  aggregate accuracy, P50/P95 latency, error rate
write results to benchmarks/results/<iso-timestamp>.json
emit Markdown summary
```

Outputs are committed. Each commit that changes a prompt or model triggers
a benchmark run (manual at first, GitHub Action later).

## 7. Scoring Rules

- **Exact-match fields** (Government Warning text, country, class/type):
  binary pass/fail after Unicode-normalize + smart-quote-fold +
  whitespace-collapse.
- **Numeric fields**:
  - **ABV**: `pass` if `|measured − declared| ≤ tolerance(class)`. Tolerance
    is the TTB-style absolute percentage-point band per class — beer ±0.3 pp,
    wine ±0.5 pp (under 14 % ABV) / ±1.0 pp (≥ 14 %), distilled spirits
    ±0.15 pp. ("±0.1 %" was ambiguous — these are percentage *points*,
    absolute, not relative.)
  - **Net contents**: `pass` if values match exactly after unit conversion;
    "12 fl oz" matches "355 ml" (within ±1 ml rounding).
- **Fuzzy fields** (brand name, producer name/address):
  - Normalize (Unicode-fold, lowercase, strip punctuation, collapse
    whitespace).
  - Default `pass` if Levenshtein ratio ≥ 0.92 **AND** token-set ratio ≥
    0.85. The token-set backstop handles short brands where one edit can
    sink the Levenshtein ratio — e.g. "Bud" vs "Sud" (ratio 0.67) fails
    cleanly, while "Coors Light" vs "Coots Light" rightly fails despite a
    misleading 0.91 character-ratio.
  - Producer/address: compared per *component* (street / city / state / zip)
    after structured parsing; one mismatched component returns `REVIEW`
    rather than collapsing the whole field to FAIL.
- **Government Warning** scored as four sub-scores:
  - `text`: normalized exact match against `GOVERNMENT_WARNING_BODY`.
  - `caps`: prefix is all-caps after Unicode-fold.
  - `bold`: prefix stroke width ≥ 1.4 × body stroke width (relative, not
    absolute). Ambiguous middle (1.2–1.4×) returns `null` → counted as
    REVIEW, not pass.
  - `size`: prefix glyph height ≥ §16.22 minimum (1 mm or 2 mm depending
    on inferred container size).
  - Aggregate `pass = min(subscores)`; aggregate confidence = `min`
    confidence across sub-scores. One weak signal poisons the field, which
    is the right semantic for the strictest rule.

## 7a. Statistical Reporting (the part that makes the claim defensible)

Headline numbers without confidence intervals are not defensible. Every
benchmark run reports:

- **Wilson 95 % CI** on every accuracy point estimate.
- **Stratified accuracy table** — per (beverage type × image condition ×
  field). The reviewer sees "we fail 18 % on low-light spirits Gov
  Warning," not just "94 % overall." This is what a regulator wants.
- **Per-technique-pair McNemar's test** — for any "A is better than B"
  claim in the decision record, the p-value is reported. Two techniques
  inside the CI of each other are reported as a tie, not a winner.
- **Per-field false-negative rate** for Government Warning, separately
  from overall accuracy. FN = "passed a non-compliant label" — the
  regulator-dangerous direction.
- **Out-of-distribution column** — accuracy on the 10 real labels,
  reported separately from the synthetic+degraded headline.

## 8. Continuous Validation

Even after picking a technique, the corpus stays alive:

- Every PR that touches the extractor runs `npm run bench:smoke` (a 20-image
  subset) and must not regress.
- A nightly full-run records drift if any hosted model silently updates.

## 9. What We Will Not Test (Yet)

- Adversarial labels designed to fool the model.
- Non-English-character labels (out of scope for prototype).
- Live load tests beyond the 300-image batch case (which the architecture
  already handles).

## 10. Reproducibility Checklist

- [ ] Test corpus generation script is deterministic given a seed.
- [ ] Ground-truth JSON is committed alongside images.
- [ ] Benchmark results record model version + prompt hash.
- [ ] `npm run bench` works from a clean clone.
