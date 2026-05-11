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

### 2.1 Scope cut — what we will actually benchmark

The first draft of this document listed 10 individual techniques and 6
combinations. The post-review pass (see `REVIEW-PASS.md`) showed that 16
contenders × 100 labels gives ≈ 6 labels per cell — the predicted accuracy
gaps are inside the Wilson 95 % CI noise floor and the choice would be
unfalsifiable. We are deliberately benchmarking **four contenders**:

| ID | Technique | Why this one |
|----|-----------|--------------|
| **T1** | **Tesseract OCR** baseline | Free, offline, no API. The "could the simplest thing work?" honest baseline a regulator will want to see compared against. |
| **T4** | **GPT-4o-mini Vision** | Fast-tier hosted VLM. Default candidate for the cost/speed Pareto front. |
| **T6** | **Gemini 2.0 Flash Vision** | Alternative fast tier; competing provider so we are not single-vendor in our claim. |
| **C1** | **OCR + Vision (combined)** | Working hypothesis. T1 output is concatenated into the T4 (or T6, whichever wins) prompt; the vision model is told to cross-reference. |

If C1 wins, we may also implement the **tiered escalation** wrapper (call
it C5) — a fast call first, a stronger model only when confidence is low —
*time permitting after the vertical slice ships*.

### 2.2 Techniques we explicitly chose not to benchmark (and why)

| ID | Technique | Why dropped |
|----|-----------|-------------|
| T2 | PaddleOCR | No first-class Node binding; would force shelling to Python and break the "one Next.js artifact" deploy thesis. |
| T3 | GPT-4o (full) | Same family as T4 — keeping T4 is enough for an OpenAI signal. T3 is reserved as the escalation target if C5 is implemented. |
| T5 | Claude Sonnet Vision | Strong model, but adding a third hosted provider widens the matrix without changing the decision. Reserved as a fallback if T4/T6 both underperform. |
| T7 | Florence-2 | Will not fit a Vercel serverless function (Hobby 250 MB / Pro 500 MB limit; Florence-2 base ≈ 460 MB). On CPU realistic cold latency is 20–120 s — outside the 5 s budget. Would require a hosted GPU endpoint, which defeats the "local" framing. |
| T8 | moondream2 | Same as T7 — 1.8 GB quantized, CPU latency 5–30 s warm. Not Vercel-deployable in a way that helps R1. |
| T9 | Google Document AI | Specialized for *documents* (forms, tables) — labels are visual art, not structured documents. Reviewer would correctly ask why we chose a forms tool. |
| T10 | AWS Textract | Same reasoning as T9; both are out-of-paradigm. |
| C2 | Multi-OCR consensus | Two OCRs do not solve the dominant failure mode (stylized fonts), and we already dropped PaddleOCR. |
| C3 | OCR + ML classifier | Equivalent to C1 with extra moving parts. |
| C4 | Multi-model consensus | Doubles cost and latency for an accuracy delta we cannot show with 100 labels. |
| C6 | Local-first w/ hosted fallback | Predicated on T7/T8 working in a Vercel function — see above. Honest replacement is **OCR-only graceful degradation**: if the hosted call times out or 5xxs, we fall back to Tesseract + rule-based validators (Gov Warning text + brand fuzzy match), surfacing the rest as `REVIEW`. This is now part of the architecture, not a benchmark contender. |

### 2.3 Variants kept in scope (P2 backlog)

- **C5 Tiered escalation** — fast model first, strong model on low
  confidence. Implementable in a few hours once C1 lands, so it stays as a
  stretch goal in `TODO.md` Phase 3.5.
- **T5 Claude Sonnet** — a one-line provider swap if T4/T6 both lose to
  unrelated factors. Adapter code is parameterized to support this without
  benchmark scope expansion.

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

These are pre-registered predictions, recorded *before* the benchmark runs,
so the post-run write-up can show priors-vs-reality. Falsifiable
hypotheses, not "we will pick whatever wins."

| ID | Predicted Accuracy (overall) | Predicted Gov-Warning Acc. | Predicted P50 | Cost / 1k labels | Network-free? |
|----|------------------------------|-----------------------------|---------------|-------------------|----------------|
| T1 Tesseract | 55–70 % | 30–50 % | 1.0–1.8 s | $0 | Yes |
| T4 GPT-4o-mini Vision | 82–90 % | 75–90 % | 1.8–3.0 s | ≈ $0.50 | No |
| T6 Gemini 2.0 Flash Vision | 85–92 % | 80–92 % | 1.2–2.2 s | ≈ $0.10 | No |
| C1 OCR + Vision (T1 + T4 or T6) | 90–96 % | 88–96 % | 1.8–3.0 s | ≈ $0.10–0.50 | No |

### 4.1 The hypothesis (falsifiable)

**Working hypothesis:** C1 beats the best single hosted model on
Gov-Warning accuracy *and* on overall accuracy.

**Predicted delta** (this is the falsifiable claim, not the absolute
levels): C1 Gov-Warning accuracy ≥ best-single + **3 pp**, with no
worse than +0.5 s P50 latency. If the measured delta is smaller than
3 pp or the latency cost exceeds 0.5 s, we cannot defend the added
complexity; we ship the single-model winner instead.

### 4.2 Kill criterion

**We reject C1 if:** vision-only matches it within 2 pp accuracy AND
runs ≥ 30 % faster. In that case the simpler architecture wins and the
take-home submission says so explicitly. The pre-registered kill
criterion is itself a quality signal: it says we will *follow the data*,
not the prior.

### 4.3 What would surprise us (we want to find these)

- Tesseract on its own outperforming a hosted model on
  Gov-Warning-text-match because hosted models paraphrase. (Plausible —
  large language models love to "fix" misspellings, including
  *correct* regulatory language.)
- Gemini Flash beating GPT-4o-mini by more than 5 pp at half the cost.
  (Plausible — Gemini Flash has been ahead on vision benchmarks recently.)
- OCR text *hurting* the vision call because the model defers to the OCR
  on stylized text where OCR is wrong. (Plausible — would invalidate the
  C1 thesis entirely.)

The post-run section §6 will record what surprised us. If nothing did, we
either learned nothing or wrote priors that conveniently fit the result.

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
