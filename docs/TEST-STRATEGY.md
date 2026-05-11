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

Minimum **100 labels** for the v1 benchmark. Distribution:

| Axis | Targets |
|------|---------|
| Beverage type | ~40 beer, ~30 wine, ~30 spirits |
| Image quality | 40 clean, 30 angled / perspective-skewed, 15 low-light, 10 glare, 5 partially occluded |
| Label style | Modern, vintage, minimalist, dense-text, foreign-language |
| Government Warning correctness | 70 compliant, 20 subtly non-compliant (missing word, wrong case, not bold), 10 missing entirely |
| Brand name complexity | 40 single-word, 30 multi-word, 15 with apostrophes/punctuation, 15 with stylized caps |
| ABV range | Beer 4–8%, wine 11–14%, spirits 35–50% |

Synthetic edge cases are intentional: a model that only handles clean photos
fails R4.

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

### 3.3 Public-Domain Real Labels (~10 labels)

A small set of real beverage labels (sourced from regulator-public COLA
disclosures) for sanity-checking that we haven't overfit to synthetic
artifacts. Ground truth here is **hand-transcribed**, then verified by a
second pass with a top-tier vision model, then **diffed** — disagreements
get human resolution.

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
enters the benchmark set. This prevents us from grading techniques against
a flawed answer key.

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

- **Exact-match fields** (Government Warning, country, class/type):
  binary pass/fail.
- **Numeric fields** (ABV, net contents):
  - `pass` if within ±0.1% absolute for ABV, exact match (post unit
    conversion) for net contents.
- **Fuzzy fields** (brand name, address):
  - Normalize (lowercase, strip punctuation, collapse whitespace),
  - `pass` if Levenshtein ratio ≥ 0.92.
- **Government Warning bold/caps check**:
  - Separate sub-score; counted in the "strict accuracy" pillar.

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
