# Codex Handoff — AI Label Corpus Batch 02

> Paste **everything below the dotted line** into Codex as a single
> prompt. The first batch (ai-label-0001 through 0050) is in
> `test-data/ai-generated/labels/` already. This batch (0051-0080) is
> a targeted augmentation focused on the failure modes the current
> bake-off has weak coverage on.

---

You are augmenting a TTB Certificate of Label Approval (COLA)
verification prototype's test corpus. The repo is at
github.com/XanderXML-Bit/label-verify.

CONTEXT — what already exists:
The corpus has two halves today:
  test-data-v2/labels/           — 90 SVG-rendered synthetic labels
                                   (.png, flat, perfect-quality)
  test-data/ai-generated/labels/ — 50 photographic-quality labels you
                                   produced previously (.jpg, realistic
                                   bottles + cans, mixed lighting, mixed
                                   beverage types, Spanish-language warning,
                                   upside-down orientation, mixed substrates)

Each label has a JSON ground-truth file in the sibling `ground-truth/`
directory. The v2 schema is the authoritative one (the bench harness
consumes this shape exactly):

{
  "id": "ai-label-0051",
  "source": "real",
  "image": "test-data/ai-generated/labels/ai-label-0051.jpg",
  "degradations": ["perspective-heavy", "glare-on-warning"],
  "beverage_type": "beer" | "wine" | "distilled_spirits" |
                   "fortified_wine" | "malt_beverage",
  "label_face": "front" | "back" | "wrap" | "neck",
  "container_size_ml": 355,
  "fields": {
    "brand_name": "Stone's Throw",
    "class_type": "India Pale Ale",
    "class_category": "beer" | "wine" | "distilled_spirits" | "fortified_wine",
    "abv_percent": 6.4,
    "net_contents": { "value": 12, "unit": "fl_oz" },
    "producer": "Stone's Throw Brewing Co., Portland, OR",
    "country_of_origin": "USA" | null,
    "government_warning": {
      "present": true | false,
      "text_matches_regulation": true | false,
      "prefix_all_caps": true | false,
      "prefix_bold": true | false,
      "meets_size_minimum": true | false
    }
  },
  "gov_warning_case": "C0" | "T1_PREFIX_TITLE_CASE" | "X1_MISSING_WARNING" |
                      "X3_WRONG_LANGUAGE" | "S2_WARNING_TOO_SMALL" |
                      "Q3_PARTIAL_OCCLUSION" | ... ,
  "notes": "One short sentence describing what's distinctive."
}

`country_of_origin` MUST be `null` if and only if no country marking is
visibly present on the label (regardless of where the producer is
located — producer address is separate). Batch 01 had systematic drift
on this; please be strict.

CANONICAL GOVERNMENT WARNING TEXT (27 CFR §16.21, memorise it):

  GOVERNMENT WARNING: (1) According to the Surgeon General, women should
  not drink alcoholic beverages during pregnancy because of the risk of
  birth defects. (2) Consumption of alcoholic beverages impairs your
  ability to drive a car or operate machinery, and may cause health
  problems.

A label is COMPLIANT on the warning iff: the text matches that string
verbatim (line breaks may vary), the prefix "GOVERNMENT WARNING:" is in
all caps AND visibly bolder than the body text, and the type size is
readable (informally: 2mm+ at the actual scale).

WHAT I NEED YOU TO GENERATE — 30 new images, ai-label-0051 through
ai-label-0080. The previous 50 covered the happy-path diversity well;
this batch should TARGET FAILURE MODES our LLM-vision pipeline is most
likely to mis-handle:

GROUP A — Government Warning paraphrase / mistranscription stress
(10 images, ai-label-0051 through 0060). These are SUBTLE non-compliance
cases where a vision model might "fix" the text to the canonical form
when it should report what's actually printed. Make sure the visible
text on the label is wrong but PLAUSIBLY-WRONG, not absurd. Examples:

  - 0051: "(1) According to the Surgeon General, pregnant women should
    not drink..." (paraphrase — "pregnant women" instead of "women
    should not drink ... during pregnancy"). gov_warning_case:
    "X6_PARAPHRASE", text_matches_regulation: false.
  - 0052: "...risk of birth defects. (2) Drinking alcoholic
    beverages impairs..." ("Drinking" instead of "Consumption of").
    Same shape.
  - 0053: omits the parenthetical "(1)" and "(2)" numerals.
  - 0054: drops the comma after "Surgeon General".
  - 0055: substitutes "alchohol" or "alcoholic beverage" (singular)
    for "alcoholic beverages".
  - 0056: prefix written as "GOVERNMENT WARNING," (comma instead of
    colon). gov_warning_case: "X4_MISSING_COMMA".
  - 0057: prefix written as "Government Warning:" (title case, not all
    caps). gov_warning_case: "T1_PREFIX_TITLE_CASE".
  - 0058: prefix written as "GOVERNMENT WARNING:" but in the SAME
    weight as the body (not bold). gov_warning_case: "T3_PREFIX_LIGHT".
  - 0059: full warning rendered at maybe 1.0-1.2mm height (too small
    against the §16.22 minimum). gov_warning_case: "S2_WARNING_TOO_SMALL".
  - 0060: warning is COMPLETELY MISSING from the label. gov_warning_case:
    "X1_MISSING_WARNING", present: false.

GROUP B — Photo-quality stress (10 images, 0061-0070).

  - 0061: heavy perspective angle (label rotated 30-45° off-axis).
    degradation: "perspective-heavy"
  - 0062: harsh specular glare across the warning text.
    degradation: "glare-on-warning"
  - 0063: low-light / under-exposed (still readable, just dim).
    degradation: "lowlight"
  - 0064: partial occlusion (a finger holding the bottle covers the
    edge of the warning text). degradation: "occlusion-finger"
  - 0065: label peeling at one corner, slightly creased.
    degradation: "peeling"
  - 0066: motion-blur (handheld phone photo).
    degradation: "motion-blur"
  - 0067: yellowed / aged paper substrate, low-contrast text.
    degradation: "aged-paper"
  - 0068: photographed through plastic shrink-wrap (slight diffraction
    + reflections). degradation: "shrinkwrap-distortion"
  - 0069: small-container label (50 mL airline-spirits bottle) where
    the warning is supposed to be there but is genuinely too small.
    degradation: "small-container"
  - 0070: photographed at a steep oblique with the warning text on the
    edge of the visible area (curved-substrate distortion).
    degradation: "curved-substrate"

GROUP C — Novel beverage categories + bilingual (10 images, 0071-0080).

  - 0071: hard cider, 12 fl oz can, USA produced, compliant warning
  - 0072: sake (rice wine), 720 mL bottle, imported from Japan, compliant
  - 0073: hard kombucha, 16 fl oz can, USA, compliant
  - 0074: RTD canned cocktail (margarita), 12 fl oz, compliant
  - 0075: mead, 750 mL, compliant
  - 0076: BILINGUAL label — English warning AND Spanish "Advertencia
    del Gobierno" stacked, both compliant
  - 0077: French wine, imported, compliant English warning (NO French
    warning required — just English)
  - 0078: low-alcohol beer (2.5% ABV — below the typical 5% range)
  - 0079: high-alcohol craft beer (12% ABV — beer category, ABV is at
    the high end of plausibility)
  - 0080: malt-beverage flavoured (e.g. seltzer-malt with fruit), 16 fl
    oz can, compliant

REQUIREMENTS for every image:

  1. Resolution: at minimum 768px on the long edge. JPG format.
  2. Realistic substrate — actual bottle, can, or label-card on a
     plausible surface. NOT a flat SVG render. Photo-style if possible.
  3. The seven regulated fields must be VISIBLY present (or, for the
     `missing`/`null` cases, visibly absent in a way the validator can
     detect).
  4. Brand names must be PLAUSIBLY-FICTIONAL — invent them. Do not
     use real TTB-approved brands.
  5. For each image, write the ground-truth JSON file at
     `test-data/ai-generated/ground-truth-v2/ai-label-0NNN.json` in
     the v2 schema above. The `image` field MUST be the relative path
     `test-data/ai-generated/labels/ai-label-0NNN.jpg`.
  6. `gov_warning_case` MUST be filled in for every label.
  7. `notes` is one short sentence — what's the distinctive thing
     about this image?

DO NOT generate images you can't write an honest ground-truth JSON for.
If a Group A subtle-paraphrase is too hard to render with the difference
visibly present, skip it and produce a compliant label in that slot
instead — but tag it `compliant` (`C0`) honestly in the JSON.

After generation:
  - Write a summary file at
    `test-data/ai-generated/batch-02-manifest.md` listing all 30 images,
    their gov_warning_case, and their distinctive features.
  - List any slots you couldn't fill (slot + reason).

Commit everything to a branch called `corpus/ai-batch-02` and open a PR.
