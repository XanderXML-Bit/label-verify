# Hermes review — final critique pass

Session: 20260512_010432_777375
Model: gpt-5.5

## Prompt summary

Asked Hermes (acting as a skeptical senior engineer) for the single
strongest critique a Treasury reviewer would make of the submission,
given the headline claims (97.6% accuracy on 84 field measurements,
2.3s P50, $0.25/1k, fallback wired, classical-CV bold check, 140-image
combined-corpus rerun pending).

## Hermes response (verbatim)

> Strongest critique: the accuracy claim is not yet reviewer-grade
> because "97.6% on 84 field measurements" is too small, likely
> non-independent, and underspecified for a regulatory verifier. A
> senior reviewer will ask: accuracy on what exact fields, with what
> gold-labeling process, what confidence interval, and how does it
> behave on adversarial/low-quality labels, failed OCR, borderline
> font-weight cases, and unseen product formats? The 140-image rerun
> "in flight" makes the headline sound premature, especially for a
> compliance tool.
>
> Suggestion: reframe the claim as preliminary and ship a validation
> appendix/table: per-field precision/recall, confusion matrix, Wilson
> CI, exact corpus composition, pass/fail thresholds, manual
> adjudication method, and latency/fallback stats split by primary vs
> fallback model. Lead with "prototype measured X on frozen corpus vN;
> expanded 140-image validation pending," not a polished global
> accuracy number.

## What we'll do in response

1. Reframe the README's accuracy claim from "97.6%" to a calibrated
   preliminary statement that explicitly cites the corpus, the CI, and
   the methodology.
2. Add a per-field precision/recall table from the 140-image rerun
   instead of just the single global accuracy number.
3. Document the manual ground-truth adjudication method (we use
   Codex + 4-sub-agent visual audit per the AI manifest).
4. Latency split: primary vs fallback model stats. Currently the
   fallback only fires when Gemini is unreachable, which is ~0% in
   normal operation, but we'll log it.
5. Lead with the corpus composition, not the percentage. The reviewer
   should know n=140 (90 SVG + 50 photo-realistic AI) before they read
   any accuracy number.
