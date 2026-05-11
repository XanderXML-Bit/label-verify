# Government Warning — Non-Compliance Test Case Taxonomy

> Enumerated subtle non-compliance cases the corpus's "non-compliant"
> bucket must exercise. See `TEST-STRATEGY.md` §2 (the 40/40/20 split) and
> `src/lib/validation/government-warning.ts`.
>
> Each case is a specific failure mode the validator must catch. A v1
> benchmark must include at least one example per row; the v1 target is
> 40 non-compliant labels distributed across these axes.

## Subscore: text (R5 text fidelity, 27 CFR § 16.21)

| # | Failure mode | Example | Why it's a regulator fail |
|---|--------------|---------|--------------------------|
| T1 | Word substitution | `may cause health issues` instead of `may cause health problems` | Federal text is exact; no synonym tolerance. |
| T2 | Article drop / pluralization slip | `risk of birth defect` instead of `risk of birth defects` | Same — exact text. |
| T3 | Missing comma | `women should not drink alcoholic beverages during pregnancy because…` (comma between phrases dropped) | Text is reproduced exactly per regulation. |
| T4 | Numeral reorder | `(2)` clause appears before `(1)` | Regulation specifies the sequence. |
| T5 | Punctuation swap | `…birth defects; (2)…` (semicolon for period) | Period is the regulated separator. |
| T6 | Smart-quote contamination | Body uses `"` or `'` (curly) instead of straight quotes | OCR variant of designer stylization — should normalize and still match. |

## Subscore: caps (prefix all-caps requirement)

| # | Failure mode | Example | Why it's a fail |
|---|--------------|---------|-----------------|
| C1 | Title-case prefix | `Government Warning:` | Regulation requires all caps. |
| C2 | All lowercase prefix | `government warning:` | Same. |
| C3 | Mixed-case prefix | `GOVERNMENT Warning:` | Same. |

## Subscore: bold (prefix relative bold)

| # | Failure mode | Example (rendering) | Why it's a fail |
|---|--------------|---------------------|-----------------|
| B1 | Prefix in regular weight, body in regular weight | Prefix and body both Helvetica Regular | No bold = fail. |
| B2 | Body bold, prefix regular | Inverse weight relationship | Prefix is not the bold target. |
| B3 | Prefix in medium weight (not bold) | Prefix at font-weight 500, body at 400 | Ratio < 1.4× → fail or REVIEW. |
| B4 | Prefix in heavy/black but textured background fools naïve detection | Heavy on kraft paper — visual reads bold, pixel density wobbles | Must catch correctly. Borderline (1.2–1.4×) → REVIEW, not silent pass. |

## Subscore: size (27 CFR § 16.22)

| # | Failure mode | Example | Why it's a fail |
|---|--------------|---------|-----------------|
| S1 | Prefix below 2 mm on a > 237 ml container | Prefix glyph height measured at 1.5 mm equivalent on a 750 ml bottle | § 16.22 minimum violated. |
| S2 | Prefix below 1 mm on a ≤ 237 ml container | 0.7 mm on a 50 ml airline shooter | Same. |
| S3 | Warning crowded against other label text (no separation) | No box, no whitespace separator | "Conspicuous and readily legible" — borderline, returns REVIEW. |

## Cross-cutting

| # | Failure mode | Example | Why it's a fail |
|---|--------------|---------|-----------------|
| X1 | Missing entirely | Label has no warning text anywhere | Hard fail. |
| X2 | Warning present but on the bottom of the cap rather than a primary face | Surface ambiguity — § 16.21 requires "readily legible." | REVIEW. |
| X3 | Warning text correct but rendered in a foreign-language paraphrase elsewhere on the label | Bilingual labels — the *English* statement must still be present and exact. | Hard fail if English statement is absent. |

## v1 Target Distribution

40 non-compliant labels across these cases:

- 10 × T1–T6 (text fidelity)
- 6 × C1–C3 (caps)
- 8 × B1–B4 (bold)
- 6 × S1–S3 (size)
- 10 × X1–X3 (cross-cutting)

20 × "missing" — no warning at all. (Easy positives for the X1 detector.)

## Why this taxonomy matters

A reviewer who probes the validator will ask: "what failure mode does
this *not* catch?" The taxonomy is the answer — every named axis maps
to a corpus slice and a sub-score. Anything the validator passes that
should have failed is traceable to a specific row above.
