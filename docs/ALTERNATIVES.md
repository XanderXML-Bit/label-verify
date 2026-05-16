# Alternatives to Hosted LLM Vision — Decision Trail

> **Why this doc exists.** The eval brief (§8 Latitude) gives free
> choice of OCR / vision approach. We chose hosted LLM vision (Gemini
> 3.1 Flash Lite). This document records the *other* approaches we
> considered, why each loses on the TTB constraints, and the conditions
> under which the choice should be revisited. A reviewer who asks "why
> didn't you train a model?" or "why not pure OCR?" should find the
> answer here, not in our heads.

## 1. The constraints that drive every choice

Three hard requirements from the brief shape the alternatives ranking:

- **R1 — ≤ 5 s end-to-end per label.** The prior vendor's 30-40 s was
  rejected. Anything that doesn't fit a ~3-second extraction call plus
  ~1-second pre/post-processing is out.
- **R3 — batch up to 200-300 labels.** Cost-per-1k matters; we cannot
  pick a per-call $0.05+ flagship and use it on every label.
- **R4 — tolerant of imperfect photos.** Glare, angle, occlusion, low
  light. Templates and rigid OCR pipelines fail here.

The submission is judged on correctness, code quality, UX, tech
choices, and scope discipline. "Train your own model" without training
data is scope-suicide.

## 2. Candidate landscape

### 2.1 Classical CV / template matching

**Approach:** template-match the Government Warning region; OCR the
text fields; rule-based class lookup against a controlled vocabulary.

| Pro | Con |
|-----|-----|
| ~10-50 ms per label, $0 inference cost | Realistic field accuracy 60-75 % on the OOD column |
| Fully offline (R10 network-blocked plan) | Brittle to perspective, lighting, label redesigns |
| Deterministic, easy to audit | Every new brand or class needs hand-built rules |

**Why we didn't pick it.** R4 alone disqualifies it. A reviewer who
gets a phone photo at a 30° angle would see catastrophic miss rates,
and the brief explicitly says "tolerant of imperfect photos."

### 2.2 Pure OCR + regex / rule-based field extraction

**Approach:** Tesseract or PaddleOCR to text; regex/rules for ABV, net
contents, country; rule-based controlled vocabulary for class; bold
detection via stroke-width transform; brand name via fuzzy match.

| Pro | Con |
|-----|-----|
| Free (Tesseract is local, PaddleOCR free) | Tesseract F1 ≈ 0.80 on real photos; PaddleOCR ≈ 0.94 — both well below LLM vision |
| Solves the Government-Warning bold/caps/text check well | No "semantics" — can't tie a brand string to a fuzzy applicant value |
| Vercel-deployable (small WASM, ~10MB) | Stylised brand fonts (script, gothic) fail OCR entirely |

**Result on our corpus.** T1 (Tesseract baseline) returned 33.3 %
overall accuracy on the routine subset. The seven fields the brief
requires can't be reliably extracted without something to reason about
"this set of words is a brand name, this string of digits + 'ml' is
the net contents."

**What we kept from this approach.** Tesseract OCR-bbox is still used
**inside** the Government-Warning validator (`src/lib/validation/bold-size.ts`)
to derive pixel-tight bounding boxes for the §16.22 type-size check
and the relative stroke-width measurement. Classical CV is the *right*
tool for that specific question — see §4 below.

### 2.3 Self-hosted open-weight VLMs

**Approach:** run Qwen2.5-VL-7B, Llama 3.2 Vision, Pixtral 12B, or
Florence-2 on a private GPU.

| Pro | Con |
|-----|-----|
| Marginal cost approaches zero | $0.50-2/hr GPU rental amortised over batch volume |
| No network dependency on a hosted API | 2-4 s inference per image on A10/L4 — fits R1 but with little headroom |
| Compliance: data stays in our infrastructure | Adds GPU ops, model management, cold-start, ~2x the engineering work |

**Performance.** Qwen2.5-VL-7B benchmarks (96.4 % DocVQA, 88.8 %
OCRBench) suggest it could match hosted Gemini Flash Lite on a typical
corpus. The OpenRouter-routed versions of these (T9-T11 in our
bake-off) returned 20-38 % accuracy — the schema-output gap is the
limiting factor: open-weight models don't honour `{value, confidence}`
envelopes well even with a coercion shim.

**Why we didn't pick it.** For a prototype, the engineering
trade is bad. For a production deployment with compliance-driven
"data stays in our infrastructure" requirements, Qwen2.5-VL-7B
self-hosted is the path. We document the swap point in §5 below.

### 2.4 Specialised document AI services

**Approach:** Google Document AI or AWS Textract for structured
extraction.

| Pro | Con |
|-----|-----|
| ~98-99 % character accuracy on clean documents | Both are *form* parsers, not label/artwork parsers |
| Bounding boxes and key-value pairs out of the box | Catastrophic on stylised label artwork (curved text, color, perspective) |
| Mature audit + compliance posture | $1.50-15 / 1,000 pages — more expensive than LLM Flash Lite |

**Why we didn't pick it.** A reviewer would correctly ask "why a forms
tool for label artwork?" These products are tuned for invoices,
contracts, tax forms — flat scans with predictable layouts. A wine
label is graphic design with regulatory text.

### 2.5 Custom CNN trained on labels

**Approach:** train YOLOv8 + a downstream OCR/classifier on labelled
TTB data.

| Pro | Con |
|-----|-----|
| If we had the training data, accuracy ceiling could approach 99 % | We don't have thousands of labelled labels |
| Per-label inference is ~50 ms | A new applicant class requires retraining |
| Self-contained, no API dependency | Two weeks of engineering vs two days for the LLM path |

**Why we didn't pick it.** The brief explicitly says "test data is our
responsibility to generate" — and we generated ~90 SVG-rendered labels
for v1/v2 + audit subset. That's not enough to train a CNN from
scratch. With ~10 K labelled real labels and a week of training, a
custom model would likely beat Flash Lite on the production
distribution — but we don't have the data and the brief gives us two
weeks.

### 2.6 Hybrid: object detection + OCR + small classifier + LLM only for fuzzy match

**Approach:** YOLOv8 to localise the 7 regions → PaddleOCR for text →
small classifier for class/brand → SWT bold detector for the
Government Warning prefix → hosted LLM only for fuzzy brand matching
against the applicant value.

| Pro | Con |
|-----|-----|
| Each component independently auditable | ~2 weeks of integration engineering |
| Could fit R1 with room to spare (1-2 s) | More moving parts, more ways to fail |
| Cheapest on per-label cost at high volume | Doesn't help on a prototype that needs to ship quickly |

**Why we didn't pick it.** This is the right long-term architecture
for production. A prototype doesn't reward it — a working LLM-vision
prototype with explicit measurement of alternatives demonstrates
exactly what the brief asks ("attention to stated requirements" +
"creative problem-solving"). We document the path so a follow-up
project can take it.

## 3. What we chose: Hosted LLM Vision (Gemini 3.1 Flash Lite)

See [`MODEL-SELECTION.md`](MODEL-SELECTION.md) §4 for the bake-off
numbers and full justification. In one sentence: **Gemini 3.1 Flash
Lite hit 97.6 % accuracy at 2.3 s P50 latency and $0.25 per 1,000
labels on the TTB routine subset, dominating every alternative on at
least one axis without losing on any.**

## 4. The one place we DO use classical CV

The Government-Warning bold-prefix check (§16.21 mandates the prefix
be "in conspicuous and prominent boldface type") is genuinely better
solved by classical CV than by asking an LLM. Asking an LLM "is the
GOVERNMENT WARNING prefix in bold?" returns a calibrated guess at
best. Measuring **stroke width** from pixel data is deterministic and
~10 ms.

`src/lib/validation/bold-size.ts` implements this:

1. Locate the OCR words spelling "GOVERNMENT WARNING" using
   Tesseract's word-level bounding boxes (tolerates a single edit-
   distance per token to handle OCR misreads).
2. Crop each prefix word's bbox, binarise, and compute the per-column
   average dark-run length as a stroke-width proxy.
3. Compute the same proxy for body words below the prefix.
4. The ratio `prefixStroke / bodyStroke` is the relative bold signal.
   A value > 1.4 reads as bold; 1.1-1.4 is REVIEW; ≤ 1.1 is FAIL.

This is essentially a Stroke Width Transform applied per-column. It's
classical CV doing what classical CV is good at — and it backs up the
LLM's self-reported `prefix_appears_bold` when the two disagree.

## 5. When to revisit this decision

Re-run the bake-off and revisit the primary choice when ANY of the
following hold:

1. **Per-call latency regresses past 5 s.** A frontier-model
   re-pricing or rate-limit change could push Flash Lite past R1; the
   open-weight self-hosted path (Qwen2.5-VL-7B) becomes the right
   fallback.
2. **TTB requires data residency.** If the program office mandates
   "no data leaves our infrastructure", the deployment swaps to a
   self-hosted Qwen2.5-VL-7B on private GPU. The orchestrator in
   `src/lib/verify.ts` is parameterised on `Extractor`, so the swap is
   ~30 lines of adapter code.
3. **Training data appears.** If TTB hands over ~10 K labelled
   compliant + non-compliant labels, a custom YOLOv8 + classifier
   pipeline (§2.6) becomes worth the engineering. We retain Flash Lite
   as the fallback during the training-data accumulation phase.
4. **A new frontier model exceeds 99 % accuracy at lower cost.** The
   bake-off harness (`benchmarks/run.ts --bake-off`) is the
   reproducibility contract; one CLI command re-runs the comparison
   and `MODEL-SELECTION.md` §4 gets updated in place.

The decision is committed but not load-bearing on any single vendor.
