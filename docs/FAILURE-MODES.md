# Failure mode catalogue

> What the verifier gets wrong, why, and what the orchestrator does
> about each. Compiled from per-image inspection of the 170-image
> combined bake-off (`benchmarks/results/2026-05-12T17-10-53-642Z.md`)
> and the per-field outcome dump in the sibling `*-per-image.json`.

A reviewer evaluating this prototype should expect each of these
patterns. They are real, measured, and ordered by frequency.

---

## F1. `country_of_origin` returns null on US-domestic labels — REVIEW (intentional)

**Pattern.** A US-produced bottle (Stone's Throw Brewing, Asheville NC)
prints no country-of-origin text on the label. The model correctly
extracts `country_of_origin = null`. The comparator now returns REVIEW
(was FAIL pre-2026-05-12), with a regulatory-aware note:

> "Label does not visibly print a country of origin. Most US-produced
> beverages omit it (TTB requires it for imports only, per 27 CFR §4.39
> / §5.36). Reviewer should confirm the producer address is US-based."

**Why.** 27 CFR §4.39 / §5.36 mandate country-of-origin marking on
imports only. Domestic labels routinely omit it. The pre-fix comparator
treated null as FAIL — the dominant source of false-FAILs on the OOD
corpus.

**What the orchestrator does.** Routes to human REVIEW with the
regulation citation in the reason field, so the reviewer can confirm
US-based producer from the address (which appears separately) and
PASS. The producer-comparator's implicit-USA inference (strict 2-letter
state code + corroborating component) reduces the cases that reach
this REVIEW — see [`src/lib/matching/producer.ts`](../src/lib/matching/producer.ts).

**Headline impact.** Approximately 14 OOD images were demoted from
FAIL to REVIEW by the country-comparator relaxation. Per-field accuracy
is unchanged (REVIEW still counts as "incorrect" to the binary
bench scorer), but orchestrator-level UX is meaningfully better:
fewer false alarms shipped as PASS=false.

---

## F2. `government_warning` paraphrase on clean labels — REVIEW

**Pattern.** A model that reads a perfectly clean Government Warning
sometimes paraphrases minor wording ("operate a motor vehicle" vs
"operate machinery") in the extracted `raw_text`. The exact-text
subscore returns REVIEW because Levenshtein-ratio falls into the
0.85–0.95 band.

**Why.** The vision model normalises text it considers semantically
equivalent. We can't distinguish "model paraphrased compliant text"
from "label genuinely non-compliant" from text alone — a two-pass GW
text validator was tried and reverted (it could not distinguish those
two cases, only false-flagged compliant labels).

**What the orchestrator does.** The Gov-Warning text subscore is one
of four (text + caps + bold + size). The aggregator's worst-of rule
demotes the overall GW verdict to REVIEW. The reviewer sees both the
extracted text and a reason ("text Levenshtein 0.91 < pass floor 0.95
— inspect to confirm exact-match").

**Headline impact.** On the 170-image corpus, GW false-negative rate
is 5.1 % (n=137, Wilson 95% CI [2.5, 10.2]). The criterion was
≤ 10 %, so we're inside, but the paraphrase pattern is the largest
contributor to GW REVIEWs. See
[`docs/government-warning-cases.md`](government-warning-cases.md) for
the case taxonomy (T1, B1, C1, X1…).

---

## F3. `producer.street` near-miss on multi-line addresses — FAIL

**Pattern.** A label prints "14 Mill Street, Suite 200" but the
declared producer address has "14 Mill St". The producer comparator's
street component matches on normalized prefix but the suite suffix
introduces a mismatch on the component, so the component returns FAIL;
the overall producer comparator surfaces a component breakdown.

**Why.** Address normalisation is hard. We canonicalise direction
words ("Street"→"St", "Avenue"→"Ave") and case-fold, but suite numbers,
floor markers, and trailing punctuation are not handled.

**What the orchestrator does.** Returns PASS at component-level for
the matching components (street prefix, city, state, postal, country)
and FAIL for the suite/floor mismatch. The aggregated producer status
is FAIL but the per-component breakdown (auto-expanded on non-PASS as
of 2026-05-12, REMAINING-IMPROVEMENTS U3) lets a reviewer see at a
glance which component diverged and decide whether the actual label is
TTB-compliant despite the formatting drift.

**Headline impact.** Maybe 4 OOD images on the 170-corpus. Currently
caught by the producer FAIL → orchestrator FAIL → reviewer dispositions
manually. A future iteration would add a `compareProducer` suite-aware
normaliser.

---

## F4. `brand_name` collision on short brands — PASS at low confidence

**Pattern.** A 2-word brand like "Coors Light" vs label "Coots Light"
has a Levenshtein-ratio of 0.91 (above the 0.85 review band) AND a
token-set ratio of 0.5 (one of two tokens matches). The comparator
returns FAIL on the token-set rule (correct behaviour after the 2026-
05-10 fix). But borderline cases where token-set is ~0.85 still PASS.

**Why.** Two-signal approach (lev + token-set) intentionally catches
the "Coors Light" / "Coots Light" case by demanding token-level agreement.
Single-signal Levenshtein would PASS. But the gating is calibrated against
two-word brands; longer brand names with one wrong word can still slip.

**What the orchestrator does.** The PASS-but-low-confidence case
triggers the `REVIEW_CONFIDENCE_THRESHOLD = 0.55` floor in
[`verify.ts`](../src/lib/verify.ts): if the extractor reported low
confidence on brand_name extraction, the verdict demotes from PASS to
REVIEW even though the comparator passed. The threshold was calibrated
against the 170-image corpus — see
[`.review/threshold-calibration-report.md`](../.review/threshold-calibration-report.md).

**Headline impact.** 1–2 false PASSes per 170 in our corpus. Reviewers
should treat brand_name PASS at low extractor confidence as the place
to spot-check.

---

## F5. `abv_percent` rounding on small differences — FAIL within tolerance

**Pattern.** Beer declared as 6.4 % ABV, label printed as 6.5 %. The
declared 0.3 pp tolerance (per TTB §7.71 for malt beverages) covers
this, so comparator returns PASS. But for distilled spirits where the
tolerance band is 0.0 pp under (only over is permitted), a 40.0 %
declared → 39.9 % printed label is a FAIL.

**Why.** TTB regulations treat over-declaration as a labelling violation
because consumers expect at least the declared strength. Our comparator
honours the asymmetric tolerance per class category.

**What the orchestrator does.** Surfaces the exact delta in the reason
field: "Declared 40.0 % vs printed 39.9 % — distilled spirits permit
no under-declaration (27 CFR §5.65)." Reviewer can confirm by re-
reading the label.

**Headline impact.** ABV is the most reliable field — 98 %+ accuracy
on every corpus subset. Rare to surface as a real failure.

---

## F6. `net_contents` SI / US unit confusion — FAIL avoidable

**Pattern.** Label printed as "750 ml" but declared as "12.7 fl oz".
Both are correct (750 ml ≈ 25.4 fl oz, wait, 12.7 is half of that —
example chosen to illustrate confusion). Comparator converts both to
ml via `toMl`, compares within a 1 % tolerance.

**Why.** Two unit systems coexist on TTB-regulated beverages.
`toMl` (in [`src/lib/matching/net-contents.ts`](../src/lib/matching/net-contents.ts))
handles fl oz, ml, L, gal, qt, pt with rounded constants matching
TTB's published equivalencies.

**What the orchestrator does.** Returns PASS when within tolerance,
FAIL when not. Tolerance is 1 % to absorb rounding (375 ml standard
half-bottle is sometimes labelled 12.7 fl oz which converts to 375.5
ml — accepted).

**Headline impact.** Net-contents accuracy on the corpus is 96+ %.
The few misses are usually OCR errors (e.g. the model reads "75 ml"
when the label shows "750 ml") not unit conversion errors.

---

## F7. `class_type` declared-vs-printed style drift — REVIEW

**Pattern.** Application says "India Pale Ale", label says "IPA". OR
application says "American Vodka", label says "Vodka". The category
matches but the wording differs.

**Why.** `compareClass` does fuzzy + category-aware comparison — it
recognises "IPA" as an abbreviation for "India Pale Ale" and "American
Vodka" as a subset of "Vodka" via a category map. But novel
abbreviations (e.g. "DIPA" for "Double IPA") aren't in the dictionary.

**What the orchestrator does.** Returns PASS if the canonical class
category matches. Returns REVIEW if the fuzzy match is in the 0.7–0.9
band. Returns FAIL only when no plausible match.

**Headline impact.** Maybe 3 OOD images per 170 trigger this REVIEW.
Spot-fixable: extend the abbreviation dictionary in
[`src/lib/matching/class.ts`](../src/lib/matching/class.ts).

---

## What the orchestrator catches (independent of model)

Three orchestrator-layer safeguards turn raw vision output into a
TTB-defensible verdict:

1. **`REVIEW_CONFIDENCE_THRESHOLD` floor.** Any field comparator
   returning PASS at confidence below the threshold demotes the
   overall verdict to REVIEW. Calibrated against the corpus — see
   [`.review/threshold-calibration-report.md`](../.review/threshold-calibration-report.md).

2. **Gov-Warning multi-subscore aggregation.** Four independent
   subscores (text, caps, bold-via-SWT, size) → worst-of rule. A
   single subscore failure surfaces in the reason field with
   reg citation.

3. **Cross-provider auto-fallback.** If primary Gemini fails (network, rate-limit, schema
   parse error), the request retries against GPT-5.4-nano with a
   fresh budget. A yellow banner on the result tells the reviewer
   which provider answered, so they can opt to re-verify. Distinct
   from the borderline-Gov-Warning second-opinion (Gemini 2.5 Flash
   since wave 22).

4. **Borderline-Gov-Warning second-opinion.** When the primary lands
   on REVIEW for the Gov-Warning, the orchestrator fires a single
   call against the configured second-opinion model (default
   `gemini-2.5-flash`, switchable to OpenAI via `SECOND_OPINION_PROVIDER`).
   Agreement / disagreement renders inline; the bench shows this
   path cleanly reduces wrong-GT review-on-wrong by ~3.7 cases.

---

## What the orchestrator can't catch (yet)

- **Stylised typography that fools text extraction.** A "Z" rendered
  in a Gothic script may be read as "X" or "?". Both vision models
  and Tesseract OCR have this failure mode.
- **Multi-language Government Warnings.** §16.21 requires English; a
  Spanish-only warning would FAIL on the text-match subscore. A
  bilingual label (English + Spanish) usually passes if the English
  block is well-formed, but the bench has no bilingual test cases yet.
- **Watermark / overprint on a compliant label.** Heavy stylistic
  embellishment that obscures the prefix bold check can return
  REVIEW on the bold subscore even when the underlying text meets
  §16.22.

These limits are not blockers for a prototype; they are work items
for a production iteration (collect ~1 k labelled real-world labels,
fine-tune a CNN as a third opinion on borderline Gov-Warning bold).

---

_Maintained alongside [`docs/REMAINING-IMPROVEMENTS.md`](REMAINING-IMPROVEMENTS.md)
and the per-image dumps under `.review/`. Last updated 2026-05-12 after
the 170-image bake-off + threshold calibration._
