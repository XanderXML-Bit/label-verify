# Wave 31b — GT-noise finding (ai-label-0031, ai-label-0050)

> Tracked down the persistent compliant false-fails on `ai-label-0031`
> and `ai-label-0050` (both tagged `gov_warning_case=Q6_ROTATED_180`).
> Hypothesis "180° rotation hurts model transcription" was the obvious
> read. Falsified, then root-caused to **bad ground truth**: both labels
> have typos baked into the printed text and are non-compliant by
> 27 CFR §16.21's strict text-match requirement. The system is
> correctly returning FAIL; the bench counts them as `compliant.false-fail`
> only because the GT says they should PASS.

## The chain

1. Spot-check: manually pre-rotate both images 180° via `sharp.rotate(180)`
   before handing to `verifyLabel`. Both still fail text-subscore at
   `confidence=1.0`. Rotation hypothesis falsified.

2. Forensics dump: monkey-patch the extractor to surface
   `government_warning.value.raw_text`. Diff the model's transcription
   against the canonical 27 CFR §16.21 statement. Output:

   ### ai-label-0031 — model raw_text (as-is, the EXIF-oriented variant):
   > GOVERNMENT WARNING: (1) According to the Surgeon General, women
   > should not drink alcoholic beverages during pregnancy because of the
   > risk of birth **defetts**, (2) Consumption of alcoholic beverages
   > impairs **youf abilty tc** drive a car or operate machinery, and
   > may cause health problems.

   The model reads `defetts`, `youf`, `abilty`, `tc` — and uses a comma
   between sentence (1) and sentence (2) instead of the regulation's
   required period. Reading the printed label image directly (it is a
   rotated dry-red-wine label for "Old Schoolhouse"), the typos
   `defetts` / `youf` / `abilty` / `tc` and the comma-instead-of-period
   are clearly visible in the printed text. The label image *itself*
   contains a non-compliant Government Warning.

   ### ai-label-0050 — model raw_text (rotated-180 variant, the upright orientation for the model):
   > GOVERNMENT WARNING: (1) According to the **Surghneral**, women
   > should not drink alcoholic beverages **duirng pregnency** because of
   > **risk risls** of birth defects. (2) **Cosunmpoiton** of alcoholice
   > **bevervagens** impairs your ability to drive **e** car or operate
   > machinery, and may cause **heatth** problems.

   The "Surghneral" (in place of "Surgeon General"), "risk risls" (in
   place of "the risk"), and several letter-swap typos are again
   present in the printed image — visible directly from the rendered
   label. This is a synthetic "Little Quarry Hefeweizen" label and the
   AI generator that produced it appears to have garbled the
   government-warning text.

3. Conclusion: both labels are **non-compliant on text grounds**. The
   `Q6_ROTATED_180` tag captures *one* defect (the image is rotated) but
   the GT marks them as expected-PASS, which is wrong — a printed
   warning with typos is itself a text-content defect and a FAIL by
   27 CFR §16.21's strict literal-text requirement.

## Implication for the headline metric

- The bench currently classifies these 2 records as
  `compliant.false-fail = 2`. After GT correction they would be
  `compliant.true-reject` (or moved to a new stratum, since they're
  hybrid Q6+text-defect cases). The system's actual `compliant.false-fail`
  count is **1, not 2**, against the current production main.
- Adversarial fp-on-correct stays at 6 (unchanged — those are a
  different defect class).

## Why this took so long to find

- The labels' Q6_ROTATED_180 tag biased me toward "the rotation is what's
  failing." That hypothesis predicts that pre-rotating would fix it. It
  doesn't, so the hypothesis is falsified — but the SAME tag obscures
  that there's an *additional* defect (printed-text typos) on the same
  labels.
- The text-subscore returns `status=fail, confidence=1.0` with no
  `raw_text` or evidence carried forward in the `GovernmentWarningCheck`
  interface. To see the actual transcription that triggered the FAIL
  you have to either re-call the extractor (paying a Gemini round-trip)
  or wire a sniffer through `opts.extractor`. Neither is part of the
  default debug trace.

## Suggested follow-ups (separate change set, not part of wave-31)

1. **GT correction**: re-label `ai-label-0031` and `ai-label-0050` GT
   with an additional `text_content_defect=true` flag (or move to a
   new `Q-text-defect` stratum) and update headline metrics. The
   prediction is `compliant.false-fail` drops from 1 → 0 (after the
   2 GT corrections move out of the compliant stratum).
2. **Debug trace improvement**: add `raw_text` and a per-character diff
   to the trace returned by `verifyLabel` (gated on a debug flag) so
   future investigations don't require this scaffolding. The information
   was deliberately stripped from the response shape for the regulator-
   facing API (correctly — printed-text quotation is sensitive) but a
   `?debug=1` mode is consistent with how `LV_DEBUG_TRACE` is used
   elsewhere.
3. **Adjacent — corpus quality audit**: spot-check the rest of the
   AI-generated synthetic labels (`ai-label-*` + `syn-*`) for printed-
   text-typos baked into the image. If 2 of 80 AI-generated labels have
   bad printed text, the rate might be ~2.5% across the corpus. Even
   if so, this only matters for the 1-2 cases that happen to be GT-
   marked as quality-only defects.

## Artifacts (kept on branch only)

- `scripts/rotation-spot-check.ts` — initial 180° pre-rotation experiment
- `scripts/textfail-forensics.ts` — first cut, surfaced that gov-warning
  check doesn't carry raw_text forward
- `scripts/textfail-rawdump.ts` — sniffer-extractor approach that finally
  surfaced the typos
- This document

## Decision

**Do not ship a rotation-correction pass.** It would do nothing for these
two cases (root cause is printed-text defects, not rotation), and the
production code path already calls `sharp().rotate()` for EXIF
auto-orient — which IS doing useful work on a different subset of the
corpus. Adding non-EXIF rotation detection would require building a
classifier and is speculative.

**Recommendation to user**: file a separate task to correct these two GT
records and re-measure. Expected improvement: `compliant.false-fail`
moves 1 → 0 (the wave-25 false-fail count would be 0/170 compliant on a
GT-clean bench). No code changes needed.
