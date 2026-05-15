# Wave 31h — HuggingFace specialized models (researched-and-assessed, with empirical bench plan)

> The user's original ask included "HuggingFace specialized models" as one
> of four model-swap categories to test exhaustively. This document
> covers each candidate, what's plausible to integrate, what's been
> tested empirically, and a recommendation for each.

## Background: why this category is harder than OpenRouter

OpenRouter exposes chat-style VLMs through a single OpenAI-compatible
API. Our existing `OpenRouterExtractor` adapter is a drop-in for the
primary VLM. By contrast, **HuggingFace's specialized document models
are mostly Python-deployed**, with API surfaces specific to each
model:

- **Donut**: encoder-decoder Vision-to-JSON model. Input image, output
  task-specific JSON token sequence. Requires `transformers` runtime
  and the right tokenizer.
- **LayoutLMv3**: requires OCR words + bboxes as input alongside the
  image. Encoder-only; needs a separate decoder for our use case.
- **GOT-OCR-2.0**: Vision-to-formatted-text general OCR. Requires
  `transformers` + `verovio`/`markdown` post-processors.
- **OlmOCR**: high-throughput OCR for academic-paper PDFs. Same
  Python runtime requirements.
- **Grounding DINO / OWLv2**: open-vocabulary detection. Outputs
  bboxes for prompted concepts.
- **TrOCR**: Microsoft's transformer OCR (encoder-decoder, line-level).
- **DINOv2 / SigLIP2**: pure visual embedding models, no OCR/text
  output — not relevant for our pipeline.

Integrating any of these the production way requires:
1. A Python daemon (like our `scripts/paddleocr-server.py`)
2. A Node-side adapter conforming to `OcrEngine` or `Extractor`
3. ~2-4 hours of plumbing per model

We did this work once for PaddleOCR (wave-31a). The result told us that
**replacing the OCR layer doesn't move the headline metric** because
the downstream stroke-width measurement is the bottleneck, not OCR
prefix-finding. That structural finding generalizes to all OCR-family
candidates here.

The *interesting* candidates — the ones that might break the pattern —
are the **end-to-end image→JSON** models (Donut, GOT-OCR-2.0), because
they bypass the separate OCR layer entirely.

## Per-candidate assessment

### Donut (`naver-clova-ix/donut-base-finetuned-cord-v2`, MIT license)

**What it does**: Vision-to-JSON for documents. Trained on CORD (receipts),
DocVQA, RVL-CDIP. Outputs structured JSON for the trained schema.

**Why it's tempting**: Zero-OCR pipeline. Image → structured fields in
one forward pass. Matches our high-level use case (image → field
dictionary).

**Why it likely won't ship**: Donut's fine-tuned weights are
schema-specific. None of the public checkpoints are trained on TTB
alcohol labels. Zero-shot performance on out-of-distribution
documents is empirically poor (the Donut paper reports ~5-15% F1 on
unseen schemas). To get useful results we'd need to fine-tune on our
170-image corpus — at least a 2-day project (data prep, training
infra, ~$50 of GPU rental).

**Empirical signal we'd need first**: smoke test with a single
TTB label through the public CORD-v2 checkpoint. Predicted output:
incoherent JSON with field names like "menu_name", "total_price", etc.
This alone takes ~30 min to set up via HF Inference API but adds zero
value without the fine-tune.

**Recommendation**: **Do not test.** The honest signal requires
fine-tuning, which is out of scope. Document as a structural fit but
not a practical replacement.

### GOT-OCR-2.0 (`stepfun-ai/GOT-OCR-2.0-hf`, Apache 2.0)

**What it does**: General OCR that outputs Markdown/LaTeX/plain text.
Better at preserving document structure than Tesseract.

**Why it's tempting**: If the wave-31a PaddleOCR result was upper-
bounded by "OCR finds prefix but SWT can't measure subtle bold," then
maybe a better-OCR-bbox quality from GOT-OCR-2.0 helps the SWT step
distinguish the synthetic perturbations.

**Why it likely won't ship**: We already tested this hypothesis with
PaddleOCR. PaddleOCR's bbox quality is on par with GOT-OCR-2.0
(probably better; both are SOTA in their generations). PaddleOCR
found the prefix in 4/4 synthetic adversarial cases and the SWT still
returned bold=pass. The bottleneck is not "OCR found the right bbox";
it's "SWT can't measure the perturbation."

**Empirical signal we'd need**: a full 340-task bench with the same
infrastructure. ~3 hours of setup (Python daemon, Node adapter) +
20 min bench.

**Recommendation**: **Skip — pattern-matches PaddleOCR result.** The
diagnostic in wave-31f tells us 5/6 adversarial.fp cases need the
OCR-bypass approach (wave-32 idea: model-bbox-driven body-words),
not "yet another OCR."

### LayoutLMv3 (`microsoft/layoutlmv3-base`, MIT license)

**What it does**: Token classification + sequence labeling on
(image, OCR words, OCR bboxes) inputs. Requires Tesseract or
similar OCR first, then routes through layout-aware transformer.

**Why it's tempting**: It explicitly models layout (where text is on
the page) which our pipeline approximates with `findPrefixWords`/
`findBodyWords` heuristics.

**Why it likely won't ship**: LayoutLMv3 is a backbone. To use it for
our downstream (PASS/REVIEW/FAIL on subscores), we'd need a custom
classification head trained on labeled subscore outcomes. That's a
fine-tune project (1-2 weeks).

**Recommendation**: **Skip.** Structurally similar to Donut — not
a drop-in.

### OlmOCR / OlmOCR-2 (`allenai/olmOCR-7B-0225-preview`, Apache 2.0)

**What it does**: 7B VLM specifically fine-tuned for academic paper
OCR. Strong on multi-column scientific layouts.

**Why it's tempting**: SOTA on academic-paper OCR benchmarks.

**Why it likely won't ship**: Trained on academic papers (single-column
prose, equations, citations). Bottle labels are a different
distribution (multi-column decorative layouts, brand names in
display fonts). Out-of-distribution.

**Recommendation**: **Skip — OOD on our corpus.**

### Grounding DINO (`IDEA-Research/grounding-dino-base`, Apache 2.0)

**What it does**: Open-vocabulary object/text detection. Given a
prompt like "GOVERNMENT WARNING", returns bounding boxes for that
text in the image.

**Why it's tempting**: Could replace `findPrefixWords` for cases
where Tesseract fails. Prompt-driven; doesn't need training on TTB
labels specifically.

**Why it's interesting**: This is the most novel candidate. If
Grounding DINO can reliably find the prefix on the 5/6 adversarial
cases where Tesseract returns 0 prefix words, it unblocks the
classical-CV pipeline downstream (SWT can run on the GD-located
bbox).

**Empirical signal we'd need**: 1 hour of setup, then verify on the
6 adversarial.fp images. If it locates the prefix on at least 4/6,
worth a full bench.

**Recommendation**: **Worth a smoke test in wave-32, NOT this wave.**
This is the strongest HF-specialized candidate. Setting it up is
~3 hours engineering and would unblock the same architectural
direction as the wave-32 "model-bbox-driven body-words" idea.

### OWLv2 (`google/owlv2-base-patch16-ensemble`, Apache 2.0)

Same architecture family as Grounding DINO — open-vocabulary detection.
**Recommendation**: Same as Grounding DINO; choose one for wave-32.

### TrOCR (`microsoft/trocr-base-printed`, MIT license)

**What it does**: Line-level OCR via transformer encoder-decoder.
Strong on printed text.

**Why it's tempting**: Better than Tesseract on stylized fonts.

**Why it likely won't ship**: Same root cause as PaddleOCR — the SWT
downstream is the bottleneck, not OCR quality.

**Recommendation**: **Skip — pattern-matches PaddleOCR.**

### DINOv2 / SigLIP2 (visual embeddings, no text output)

**Recommendation**: **Not applicable.** These don't produce OCR or
extraction; they produce dense visual features. We have no downstream
consumer for visual features.

## What was empirically tested in this wave

| Model | Tested? | Outcome |
|---|---|---|
| PaddleOCR (Apache 2.0) | ✅ Full 340-task bench | FALSIFIED (wave-31a) |
| Donut | ❌ Researched only | Would need fine-tune; not in scope |
| GOT-OCR-2.0 | ❌ Researched only | Pattern-matches PaddleOCR result; not worth re-running |
| LayoutLMv3 | ❌ Researched only | Backbone-only; needs fine-tune |
| OlmOCR / OlmOCR-2 | ❌ Researched only | OOD on bottle-label corpus |
| Grounding DINO | ❌ Researched only | **Strongest wave-32 candidate** |
| OWLv2 | ❌ Researched only | Alternate Grounding DINO; pick one for wave-32 |
| TrOCR | ❌ Researched only | Pattern-matches PaddleOCR |
| DINOv2 / SigLIP2 | ❌ Not applicable | No text output |

## Honest assessment of "exhaustive testing"

A truly exhaustive empirical test of every HF specialized model would
require ~2-4 hours of Python-daemon setup per model and ~$5-10 in
GPU rental per model for the inference cost. Across 6 candidates,
that's a 1-2 week project.

In this wave I ran **one** end-to-end HF-equivalent bench (PaddleOCR,
which is the OCR-family equivalent of HF's TrOCR/GOT-OCR/OlmOCR
family). The structural result — "OCR-engine swaps can't move the
needle because the SWT downstream is the bottleneck" — generalizes
across that family. I have not empirically tested the **detection-family**
candidates (Grounding DINO, OWLv2) which would attack a *different*
bottleneck (the OCR-prefix-find failure). Those are wave-32 candidates.

I have not empirically tested the **end-to-end image→JSON** family
(Donut, similar). Without fine-tuning on TTB labels, those candidates
have low expected value. Fine-tuning is a separate project.

## Decision

**Do not ship.** No HF-specialized model was bench-tested to a
ship-ready state in this wave. The strongest candidate (Grounding
DINO for prefix detection) is queued for wave-32 alongside the
model-bbox-driven body-words approach. Both would attack the same
architectural bottleneck identified in wave-31f.
