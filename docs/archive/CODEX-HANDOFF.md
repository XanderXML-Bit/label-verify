# Codex Handoff — Test Label Corpus Generation

> **Audience:** A separate code-generation agent (Codex) being asked to
> produce the test-image corpus for this project. This document is
> self-contained — Codex does not need to read the rest of the repo to do
> the job, but cross-links are provided where the *why* matters.
>
> **Deliverable:** ~100 labeled beverage images plus matching JSON ground
> truth, committed to `test-data/labels/` and `test-data/ground-truth/`.
> A generator script that re-creates the synthetic + degraded portion
> deterministically from a seed.
>
> **Deadline contribution:** This corpus blocks Phase 2 of `TODO.md`. The
> benchmark harness (`benchmarks/run.ts`) is fully wired and will produce
> stratified accuracy + Wilson CI + McNemar pairwise tests + Gov-Warning
> false-negative rate the moment this corpus lands.

---

## 1. What the corpus is for

The repo is an AI-powered TTB Certificate of Label Approval verification
prototype. It checks beverage label images against the COLA application
data the applicant declared: brand name, class/type, ABV, net contents,
producer address, country of origin, and the Government Warning text.

To pick between four extractor techniques (Tesseract OCR baseline,
GPT-4o-mini Vision, Gemini Flash, and the combined OCR+Vision approach)
we need a corpus where we *know* every field on every label exactly.
That answer key is what this handoff produces.

The corpus also stress-tests the Government Warning validator
(`src/lib/validation/government-warning-validator.ts`), which is the
strictest field — federal regulation 27 CFR §16.21 requires exact text,
all-caps prefix, bold prefix, and a minimum type size per §16.22. The
non-compliant bucket below is the test set for that validator.

---

## 2. Corpus composition — target distribution

**100 labels total.** Distribution targets (each ±10% is fine — exact
counts matter less than coverage across every axis):

### 2.1 By beverage type
| Type | Count |
|------|-------|
| Beer / malt beverage | 35 |
| Wine | 30 |
| Distilled spirits | 25 |
| Fortified wine / RTD | 10 |

### 2.2 By source
| Source | Count |
|--------|-------|
| Synthetic (rendered via HTML/CSS + headless browser) | 60 |
| Degraded (synthetic source + transforms — see §4.2) | 30 |
| Real public-domain (TTB COLA Public Registry or equivalent) | 10 |

### 2.3 By label face
| Face | Count |
|------|-------|
| Front | 60 |
| Back (Gov Warning lives on the back for most spirits) | 30 |
| Neck / side | 10 |

### 2.4 By image condition (applied across the synthetic + degraded set)
| Condition | Count |
|-----------|-------|
| Clean (well-lit, perpendicular, no glare) | 35 |
| Angled / perspective-skewed (5°–25°) | 25 |
| Low-light (gamma 0.4–0.7) | 15 |
| Glare patches (specular highlights over part of the label) | 10 |
| Partial occlusion (thumb / sticker / hand) | 10 |
| Curved-bottle or wraparound distortion | 5 |

### 2.5 By brand-name complexity
| Pattern | Count |
|---------|-------|
| Single-word brand | 35 |
| Multi-word brand | 30 |
| Apostrophes / punctuation (e.g. `Stone's`, `O'Reilly`) | 20 |
| Stylized caps (e.g. `STONE'S THROW`) | 15 |

### 2.6 By container size (drives §16.22 type-size minimum)
| Size | Count |
|------|-------|
| Small container (≤ 237 ml) | 25 |
| Large container (> 237 ml) | 75 |

### 2.7 ABV ranges by class
| Class | Range |
|-------|-------|
| Beer | 3.5 % – 8.0 % |
| Wine | 11.0 % – 14.5 % |
| Distilled spirits | 35 % – 55 % |
| Fortified wine | 17 % – 22 % |

### 2.8 Government Warning split — the most important axis
This is the test set for the strictest field. **Flipped from the v1
draft** so the regulator-dangerous direction (passing a non-compliant
label) gets enough samples to estimate.

| Bucket | Count |
|--------|-------|
| Fully compliant (canonical 27 CFR §16.21 text, all-caps + bold prefix, ≥ §16.22 size) | 40 |
| Subtly non-compliant (one or more axes from `docs/government-warning-cases.md`) | 40 |
| Missing the warning entirely (X1 from the taxonomy) | 20 |

The 40 "non-compliant" labels should distribute across the taxonomy
(`docs/government-warning-cases.md`) approximately:
- **10 × text fidelity** (T1–T6: word substitution, article drop, comma drop, numeral reorder, punctuation swap, smart-quote contamination)
- **6 × caps** (C1–C3: title case, all-lowercase, mixed case)
- **8 × bold** (B1–B4: prefix in regular weight, body bold/prefix regular, prefix in medium weight, prefix-on-textured-background ambiguity)
- **6 × size** (S1–S3: below §16.22 minimum on large container, below on small container, crowded against other text)
- **10 × cross-cutting** (X2 readily-legible-ambiguity, X3 foreign-language-only-warning, T-axis combinations, etc.)

The 20 "missing" labels should appear visibly otherwise complete (so
they exercise the X1 detector and don't conflate "no warning" with "no
extraction").

---

## 3. Ground-truth JSON schema

One file per image, **same basename**, in `test-data/ground-truth/`.

```json
{
  "id": "syn-beer-0042",
  "source": "synthetic",
  "image": "test-data/labels/syn-beer-0042.png",
  "degradations": [],
  "beverage_type": "beer",
  "label_face": "front",
  "container_size_ml": 355,
  "fields": {
    "brand_name": "Stone's Throw Brewing",
    "class_type": "India Pale Ale",
    "class_category": "beer",
    "abv_percent": 6.4,
    "net_contents": { "value": 12, "unit": "fl_oz" },
    "producer": {
      "name": "Stone's Throw Brewing Co.",
      "street": "14 Mill St",
      "city": "Asheville",
      "state": "NC",
      "postal_code": "28801",
      "country": "USA"
    },
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

### 3.1 Field-by-field schema rules

- **`id`** — Stable string. Convention: `<source>-<beverage>-<NNNN>` —
  e.g. `syn-beer-0042`, `deg-spirits-0017`, `real-wine-0003`. The
  `<NNNN>` is the 4-digit zero-padded sequence within the source group.
  IDs must be unique across the whole corpus.
- **`source`** — `"synthetic" | "degraded" | "real"`.
- **`image`** — Repo-relative path to the image file, always
  `test-data/labels/<id>.<ext>`. Use `.png` for synthetic / degraded
  outputs (lossless preserves text edges for fair OCR comparison), and
  `.jpg` for the real-label set.
- **`degradations`** — Array of strings, applied transforms. Use the
  vocabulary in §4.2 verbatim (e.g. `"perspective:15deg"`,
  `"lowlight:0.6"`). Empty array for clean synthetic. Real labels omit
  the key (or pass `[]`).
- **`beverage_type`** — `"beer" | "wine" | "spirits" | "fortified_wine" | "rtd"`.
- **`label_face`** — `"front" | "back" | "neck"`.
- **`container_size_ml`** — Numeric, the assumed bottle size in
  milliliters. Drives the §16.22 minimum (1 mm for ≤ 237 ml; 2 mm
  otherwise).
- **`fields`** — All the regulated fields as printed on the label.
  Numeric where numeric (ABV as a number `6.4`, not `"6.4%"`).
- **`fields.net_contents.unit`** — Exactly one of `"fl_oz" | "ml" | "L" | "cl"`.
- **`fields.producer`** — Structured. Use null per missing component
  rather than empty strings.
- **`fields.government_warning`** — Four sub-flags:
  - `present` — `true` if the warning appears at all on the label.
    `false` for the 20 X1 labels.
  - `text_matches_regulation` — `true` only if the body text equals the
    27 CFR §16.21 canonical string verbatim (§5 of this doc). Any text
    deviation, even one substituted word, must set this to `false`.
  - `prefix_all_caps` — `true` only if the literal printed prefix is in
    all-caps. (`GOVERNMENT WARNING:` ✓ · `Government Warning:` ✗)
  - `prefix_bold` — `true` only if the rendered prefix weight is
    visibly heavier than the body weight on the same label.
  - `meets_size_minimum` — `true` only if the printed prefix glyph
    height satisfies the §16.22 minimum for the container size.
- **`gov_warning_case`** — One of: `null` (compliant), `"X1"` (missing),
  or the taxonomy tag (`"T1"`, `"C2"`, `"B3"`, `"S1"`, etc.). For
  cross-cutting combinations use a slash, e.g. `"T1/B2"`.
- **`notes`** — Free-form, one sentence. Helpful for human review.

### 3.2 Schema validation

A Zod schema for this exact shape will land in
`scripts/validate-corpus.ts` (TODO Phase 2). Codex can ignore it and
emit literally the JSON shape above; it will validate.

---

## 4. How to produce the images

### 4.1 Synthetic (60 labels)

**Preferred approach:** parameterized HTML/CSS templates rendered via
Playwright (or Puppeteer) headless Chromium.

- One template per `(beverage_type, label_face)` pairing. Reuse and
  re-skin liberally — *visual diversity matters less than text-content
  diversity*, since the extractor is reading text.
- Each render takes one JSON spec as input. The spec is the full
  ground-truth `fields` object plus the warning configuration (canonical
  or non-compliant variant), plus container-size and face.
- Brand names: do **not** use real trademarks. Generate from a curated
  faux-brand wordlist. Suggestions live in §6 below.
- Address: faux US/EU addresses (Faker library or hand-curated list).
- Color palette and typography vary across templates so the corpus does
  not over-fit to one stylesheet's quirks.

**Output:**
- `test-data/labels/<id>.png` (PNG so OCR sees clean edges).
- `test-data/ground-truth/<id>.json` (matches §3 schema).

**Determinism:** the generator must accept a `--seed` CLI flag so the
exact same corpus regenerates from the same seed. Default seed: `42`.

A scaffold for the generator already lives at
[`scripts/generate-corpus.ts`](../scripts/generate-corpus.ts) and is a
stub today. Codex should implement it.

### 4.2 Degraded (30 labels)

Apply transforms to a subset of the clean synthetic set. Each transform
appends to the `degradations[]` array on the ground-truth file (which
is a **copy** of the source ground truth — text is unchanged by the
transform).

Vocabulary (use exactly):
- `"perspective:<deg>"` — affine warp to simulate viewing angle.
  Reasonable degrees: 5, 10, 15, 20, 25.
- `"noise:gauss:<sigma>"` — additive Gaussian noise, sigma in 0–25 px.
- `"noise:poisson"` — sensor noise.
- `"lowlight:<factor>"` — gamma down with factor in 0.3–0.8.
- `"glare:<intensity>"` — composite a soft white radial gradient over
  a random label region; intensity 0–1.
- `"occlusion:<frac>"` — paint a fingertip/sticker rectangle over a
  random label region covering up to `<frac>` of the image area.
- `"curved:<bow>"` — cylindrical warp simulating bottle curvature;
  `bow` in 0–0.3.

Suggested distribution across the 30:
- 8 × perspective only
- 5 × low-light only
- 4 × glare only
- 4 × occlusion only
- 3 × curved only
- 6 × multi-transform combos (e.g. `perspective:10deg + lowlight:0.6`)

### 4.3 Real public-domain (10 labels)

Source from **public TTB COLA disclosures** (TTB Public COLA Registry
data — labels publicly approved are matters of public record). Save
the original photograph (JPEG) plus a `ground-truth/<id>.json` file
where every field has been **hand-transcribed by Codex from looking at
the image**.

Then run a separate top-tier vision model (Gemini 2.5 Pro / GPT-4o /
Claude Sonnet 4.6) on each image to extract the same fields and **diff
the two**. Disagreements must be reviewed and resolved by a second human
pass before committing.

Constraints:
- **Trademarks:** these labels carry trademark text. The corpus is
  inside a public GitHub repo for a prototype submission.
  Use labels from TTB's public registry only — that is the legally
  defensible source.
- **No personal info.** Producer addresses on real labels are public
  business addresses; that is OK to commit.
- **No high-resolution scans.** Compress photographs to ≤ 800 px on the
  long edge before committing — fair use is on stronger footing with
  thumbnails. JPEG quality 80.

---

## 5. The Government Warning canonical text — 27 CFR §16.21

For every label marked `fields.government_warning.text_matches_regulation = true`,
the rendered text **must** be exactly this string. Single-spaced after
periods. No paraphrasing.

```
GOVERNMENT WARNING: (1) According to the Surgeon General, women should not drink alcoholic beverages during pregnancy because of the risk of birth defects. (2) Consumption of alcoholic beverages impairs your ability to drive a car or operate machinery, and may cause health problems.
```

For the 40 non-compliant labels, the rendered text deviates in
*exactly one* axis from the taxonomy below (one mutation per label,
unless explicitly cross-cutting with `"T1/B2"` etc.). The change is
recorded in `gov_warning_case`. The taxonomy is the same one the
validator is built to catch — see
[`docs/government-warning-cases.md`](government-warning-cases.md).

Worked examples:

- **T1 (word substitution):** rendered text changes `may cause health
  problems` → `may cause health issues`. `gov_warning_case: "T1"`.
- **T2 (article/pluralization slip):** `risk of birth defects` →
  `risk of birth defect`. `gov_warning_case: "T2"`.
- **T3 (missing comma):** drop the comma after "Surgeon General".
- **T4 (numeral reorder):** the `(2)` clause appears before `(1)`.
- **T5 (punctuation swap):** semicolon for the period between (1) and
  (2).
- **T6 (smart-quote contamination):** any internal apostrophe rendered
  as `’`.
- **C1 (title-case prefix):** rendered prefix is `Government Warning:`.
- **C2 (all-lowercase prefix):** `government warning:`.
- **C3 (mixed-case prefix):** `GOVERNMENT Warning:`.
- **B1 (prefix not bold):** prefix and body both regular weight.
- **B2 (body bold, prefix regular):** inverse-weight relationship.
- **B3 (prefix in medium weight, not full bold):** prefix font-weight
  500; body 400. The "looks heavier but not enough" case.
- **B4 (textured-background ambiguity):** correct heavy prefix
  rendered over a kraft-paper / mottled background so pixel-density
  heuristics wobble. Use a noisy beige (#a87b4d) background gradient.
- **S1 (size below large-container minimum):** prefix glyph rendered
  at < 2 mm equivalent on a > 237 ml container.
- **S2 (size below small-container minimum):** prefix glyph rendered
  at < 1 mm equivalent on a ≤ 237 ml container.
- **S3 (crowded — no separation):** no whitespace / box separating the
  warning from surrounding label text.
- **X1 (missing):** no warning anywhere on the label.
- **X2 (readability ambiguity):** the warning is rendered on the bottom
  edge of a cap or in extreme arc — not "readily legible." Manually
  pick whether `present` should be `true` or `false`; document the call
  in `notes`.
- **X3 (foreign-language-only warning):** the *English* §16.21 warning
  is absent but a Spanish/French paraphrase is present. `present`
  remains `true`; `text_matches_regulation` is `false`.

For "rendering bold," use CSS `font-weight: 700` (or the platform-
equivalent in the chosen toolchain). For non-bold targets use 400. For
the B3 "medium" case use 500.

For pixel→mm conversion in synthetic renders, assume:
- The long edge of the rendered PNG corresponds to the *label height
  in mm*, scaled by `container_size_ml`.
- Common label heights (approximate): 30 mm for ≤ 50 ml, 60 mm for ≤
  200 ml, 80 mm for ≤ 375 ml, 100 mm for ≤ 750 ml, 120 mm for 1000
  ml, 140 mm for larger. Match the heuristic in
  `src/lib/validation/government-warning-validator.ts:labelHeightMmFor`.
- Render the page at 1200×1600 px (label content centered). Use
  `font-size` in px chosen so that, given the implied px/mm, the
  prefix glyph height (cap height) clears the §16.22 floor for
  compliant labels and falls below it for S1/S2 labels.

---

## 6. Faux-brand wordlist (suggestions)

To avoid trademark issues in synthetic labels. Mix and match freely.

**Beer:**  Stone's Throw, Mill Creek, Otter Bay, Rust & Ember, Wandering
Coyote, Half-Note, Bluerose, Headlands, Tin Roof, Field & Bramble, Cold
Iron, Sundial, Quiet Bear, Old Cypress, Latitude 7.

**Wine:**  Vespera, Marbled Hills, Roan & Stone, Saltwood, Côte du Soir,
Five Sisters, Calder Estates, Mira Vista, Old Schoolhouse, Castelo do
Vento, Halfwild, Solano Reach, Bertelli Family, Mt. Frieda Cellars,
Argenton.

**Spirits:**  Six Foxes, Cloister Hill, Ashby & Drake, Marrow & Bone,
Iron Magnolia, Vagrant Tide, Black Cardamom, Tarn & Heath, Vidalia
County, Mercer's Reserve, Saltgrass, North Mast, Long Whistle.

**Fortified / RTD:**  Solstice Vermouth, Madroña Port, Cave Marin,
Sunbeam Spritz, Hibiscus + Salt.

**Class/type values per category:**
- Beer: India Pale Ale, Pale Ale, Stout, Pilsner, Lager, Hazy IPA,
  Saison, Porter, Wheat Beer, Amber Ale.
- Wine: Cabernet Sauvignon, Chardonnay, Pinot Noir, Sauvignon Blanc,
  Merlot, Syrah, Rosé, Riesling, Zinfandel, Sparkling Wine.
- Spirits: Bourbon Whiskey, Rye Whiskey, Scotch Whisky, Vodka,
  London Dry Gin, Aged Rum, White Rum, Tequila Blanco, Reposado
  Tequila, Mezcal.
- Fortified: Ruby Port, Tawny Port, Sherry, Vermouth, Madeira.

---

## 7. File layout (what Codex commits)

```
test-data/
  labels/
    syn-beer-0001.png
    syn-beer-0002.png
    ...
    deg-wine-0017.png    # degraded variant of syn-wine-0001 etc
    ...
    real-spirits-0001.jpg
    ...
  ground-truth/
    syn-beer-0001.json
    syn-beer-0002.json
    ...
scripts/
  generate-corpus.ts     # implement this (it is a stub today)
```

`scripts/generate-corpus.ts` should accept:
- `--seed <n>` — random seed (default 42)
- `--count <n>` — total synthetic count to produce (default 60)
- `--degrade <n>` — how many degraded variants to derive (default 30)
- `--output test-data/` — output root (default the same dir)

It must not touch the 10 real labels; those are committed manually.

---

## 8. Quality bar / validation gate

Codex should self-check before declaring done:

1. **Every `.png`/`.jpg` in `test-data/labels/` has a matching
   `<id>.json` in `test-data/ground-truth/`.**
2. **Every ground-truth file passes Zod validation** against the schema
   stub in `scripts/validate-corpus.ts` (Codex may add this stub if not
   present).
3. **The 40 non-compliant labels span the taxonomy with the rough
   distribution in §2.8** — count by `gov_warning_case` prefix and
   compare.
4. **For each rendered compliant warning,** the exact §5 string is
   present pixel-for-pixel in the source HTML before render — i.e. the
   text isn't "compliant" merely because we said so in the JSON; it
   matches the regulation.
5. **At least 10 % of the synthetic + degraded set has been spot-checked
   by running a second vision model and confirming agreement on every
   field.** Disagreements get human review before commit.

A reviewer should be able to open any random ground-truth file, look at
the matching image, and say "yes, that is the label and yes, those are
the fields." If you can't do that, the corpus isn't done.

---

## 9. What Codex should NOT do

- **Do not** invent the canonical Government Warning text. It is
  precisely the string in §5; do not rephrase, condense, or "improve."
- **Do not** use copyrighted brand names. Faux brands only.
- **Do not** commit images that include personal identifying
  information (real producer email addresses, phone numbers, etc.).
- **Do not** modify any file outside `test-data/`,
  `scripts/generate-corpus.ts`, or `scripts/validate-corpus.ts`. The
  validator, harness, and app code are owned by a different agent.
- **Do not** push huge raw scans. Long-edge ≤ 1600 px on synthetic;
  ≤ 800 px on real labels. Keep individual files under 500 KB.

---

## 10. Handing back

When done, Codex should:

1. Commit the corpus plus the implemented `scripts/generate-corpus.ts`
   (and `scripts/validate-corpus.ts` if added).
2. Open a PR or just push to main if working directly.
3. Update `TODO.md` Phase 2 — check off the corpus items.
4. Leave a one-line summary on the PR / commit:
   *"Corpus: 60 synthetic + 30 degraded + 10 real, taxonomy distribution
   per CODEX-HANDOFF.md §2.8."*

The benchmark runner (`npm run bench`) is fully wired against the
schema this document specifies. The moment the corpus lands, the
results land in `benchmarks/results/`.
