# Verification Approach — Scientific Comparison

> This document defines **how we will choose** the verification engine. It is
> deliberately written *before* implementation so the choice is driven by
> measurement, not preference.

## 1. The Question We Are Answering

Given a label image and a set of declared field values, what extraction
strategy gives us the best joint outcome on **accuracy**, **latency**,
**cost**, and **deployment robustness**?

We will not guess. We will benchmark.

## 2. Candidate Techniques

### 2.1 Individual Techniques

| ID | Technique | Description |
|----|-----------|-------------|
| T1 | **Tesseract OCR** | Local, classical OCR. Free, offline, no API. |
| T2 | **PaddleOCR** | Heavier local OCR, generally stronger on dense layouts. |
| T3 | **GPT-4o Vision** | Hosted multimodal LLM, structured-output mode. |
| T4 | **GPT-4o-mini Vision** | Cheaper / faster tier of T3. |
| T5 | **Claude Sonnet Vision** | Hosted, alternative provider. |
| T6 | **Gemini 2.0 Flash Vision** | Hosted, fastest tier on benchmarks. |
| T7 | **Florence-2 (local)** | Microsoft open-source vision-language model, runnable via Transformers.js / ONNX. |
| T8 | **moondream2 (local)** | Small open VLM, runs on commodity hardware. |
| T9 | **Google Document AI** | Specialized document-understanding API. |
| T10 | **AWS Textract** | Specialized document API. |

### 2.2 Combination Variants

| ID | Combination | Hypothesis |
|----|-------------|------------|
| C1 | **OCR + Vision (model sees both)** | Vision model + OCR text in the same prompt outperforms either alone — model cross-references rather than re-reads. |
| C2 | **Multi-OCR consensus** | T1 + T2 reconciled = higher recall on imperfect images. |
| C3 | **OCR + ML classifier** | OCR extracts text; small classifier (e.g., heuristic + LLM) maps to fields. |
| C4 | **Multi-model consensus** | Two vision models run, a third model (or rule-based judge) reconciles. Highest accuracy, highest cost. |
| C5 | **Tiered escalation** | Fast model first (T4/T6); only escalate to T3/T5 when confidence < threshold. Optimizes the cost/accuracy frontier. |
| C6 | **Local-first with hosted fallback** | T7 or T8 by default, hosted model only when the local model declines. Hedges against network blocks. |

## 3. Evaluation Dimensions

Each technique is scored on:

| Dimension | Metric | Weight |
|-----------|--------|--------|
| Accuracy — overall | % of fields correctly extracted across the test set | **40%** |
| Accuracy — Gov Warning (strict) | % correctly passed/failed on Gov-Warning-specific test cases | **20%** |
| Latency — P50 | Median seconds per label, single-image | **15%** |
| Latency — P95 | 95th-percentile seconds per label | **10%** |
| Cost | USD per 1,000 labels | **5%** |
| Deployment complexity | Subjective 1–5; counts setup time, infra, secrets | **5%** |
| Network dependency | Boolean: does it work on a blocked-network laptop? | **5%** |

The weights reflect what the evaluator said matters: correctness first,
speed second, everything else far behind.

## 4. Expected Performance Matrix (Pre-Benchmark Hypotheses)

These are predictions, recorded before measurement, so we can see how wrong
our priors were.

| ID | Predicted Accuracy | Predicted P50 | Cost / 1k | Network-free? | Deploy Complexity |
|----|--------------------|---------------|-----------|----------------|--------------------|
| T1 Tesseract | 60–70% (struggles on stylized fonts) | 0.5 s | $0 | Yes | 1 |
| T2 PaddleOCR | 70–80% | 1.0 s | $0 | Yes | 2 |
| T3 GPT-4o | 90–95% | 3–5 s | ~$3 | No | 1 |
| T4 GPT-4o-mini | 85–90% | 1.5–2.5 s | ~$0.50 | No | 1 |
| T5 Claude Sonnet | 90–95% | 2–4 s | ~$3 | No | 1 |
| T6 Gemini Flash | 85–92% | 1–2 s | ~$0.10 | No | 1 |
| T7 Florence-2 (local) | 75–85% | 2–4 s (CPU) | $0 | Yes | 4 |
| T8 moondream2 (local) | 70–80% | 3–5 s (CPU) | $0 | Yes | 4 |
| T9 Google Doc AI | 85–90% (general docs, not labels) | 2–3 s | ~$1.50 | No | 3 |
| T10 AWS Textract | 80–85% | 2–3 s | ~$1.50 | No | 3 |
| C1 OCR + Vision | **92–97%** | 2–3 s | ~$0.10–3 | Partial | 1 |
| C5 Tiered | ~95% | 1.5 s (typical) | ~$0.30 | No | 2 |
| C6 Local-first | 80% solo, 90% with fallback | 3 s (local) / 4 s (fallback) | ~$0.10 amortized | Yes (degraded) | 4 |

**Working hypothesis:** **C1 with Gemini Flash + Tesseract** is the
likely winner on the joint axes. **C6** is the contingency if we can't rely
on hosted API availability. The benchmark will confirm or overturn this.

## 5. Benchmark Methodology

See `TEST-STRATEGY.md` for the test corpus. Pipeline:

1. **Fix the corpus** — 100+ labeled images with JSON ground truth.
2. **Implement each technique** behind a uniform interface:
   ```ts
   interface Extractor {
     id: string;
     extract(image: Buffer, ocrHint?: string): Promise<ExtractedFields>;
   }
   ```
3. **Run each extractor** across the full corpus, 3 trials per image to
   measure variance.
4. **Score** field-by-field against ground truth. Compute the weighted
   composite per §3.
5. **Publish** results to `benchmarks/results/<timestamp>.json` and a
   human-readable Markdown table.
6. **Pick** the technique (or combination) that scores highest. Document the
   choice with a reference to the benchmark run.

## 6. Decision Record (To Fill After Benchmark)

| Field | Choice | Score | Run ID |
|-------|--------|-------|--------|
| Primary extractor | TBD | TBD | TBD |
| Network-blocked fallback | TBD | TBD | TBD |
| Gov-Warning bold detection | TBD | TBD | TBD |

## 7. Reproducibility

- Benchmark harness pinned by lockfile.
- Test corpus and ground truth committed to the repo.
- Each run records: technique ID, model version, prompt hash, image set
  hash, raw outputs, scored outputs.
- Anyone can re-run `npm run bench` and reproduce the table.

## 8. Why This Is the Right Framing

A take-home that *picks a technique by intuition* tells the evaluator very
little about how the candidate thinks. A take-home that *measures and picks*
demonstrates:

- Scientific discipline.
- Awareness that "obvious" choices (e.g., "just use GPT-4o") may lose on the
  axes that actually matter (latency, network availability).
- The ability to defend a decision with data — which is the actual job.
