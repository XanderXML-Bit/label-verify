# Experiment log

These are historical results from this repository. The [benchmark protocol](BENCH-PROTOCOL.md) describes the scoring rules, and the [model selection notes](MODEL-SELECTION.md) record the live-model defaults.

## Model and scoring experiments

| Experiment | Hypothesis or question | Observed result | Commit |
| --- | --- | --- | --- |
| Original extraction comparison | Can adding OCR text to a vision prompt improve extraction? | The combined approach scored below vision alone. The live-model verifier kept OCR for warning measurements. | [02b20cc][initial] |
| Baseline repeatability | Does the earlier 76.5% score represent the current baseline? | Six runs averaged 61.3% on correct inputs. Within-session standard deviation was 0.3 percentage points. | [a910372][baseline] |
| Warning size from prompt guidance | Can the extractor infer minimum size from the warning prefix relative to the body? | The strict match rate rose, but six more defective warnings passed. The change was reverted. | [719e6a6][session] |
| Same-provider second opinion | Can Gemini 2.5 Flash resolve borderline warnings without more false passes? | False passes stayed within the budget and wrong applications were rejected more often. Correct inputs went to Review about as often. | [7bee3c6][second] |
| Warning text case-folding | Can a case-insensitive text match recover correct warnings while caps remain a separate check? | It recovered five false failures. The independent capitalization check stayed in place. | [17d101c][case] |
| Generic class on label | Can a generic beverage class match a more specific declared class? | It recovered three false failures while preserving the false-pass count. | [8449092][class] |
| Missing field extraction | Should a failure caused solely by missing extraction go to Review? | One low-quality image moved from false failure to Review. The false-pass count stayed at five. | [7cd086d][null] |
| First size threshold trial | Can a wider size band recover passes on degraded images? | The trial improved the match rate but admitted one more synthetic defect. The original corpus-wide criterion led to a revert. | [719e6a6][session] |
| Overnight replication | Do the second-opinion and comparator changes produce repeatable verdicts? | Replicates kept the false-pass count at five across the four shipped changes. | [719e6a6][session] |
| Primary model comparison | Does a larger Gemini model outperform Gemini 3.1 Flash Lite on the same corpus? | Gemini 3.1 Flash Lite retained the primary role on the measured accuracy, latency, and cost trade-offs. | [175cb16][primary] |
| Stratified guardrail | Does a single error budget hide differences between compliant, adversarial, and degraded labels? | The reanalysis separated those three strata. The earlier size threshold trial passed under the stratified criteria. | [a91bac8][strata] |
| Size threshold band | Can a wider band recover compliant passes within the stratified budget? | The match rate rose from 65.1% to 71.6%. The variant shipped with one additional adversarial false pass. | [a91bac8][strata] |
| Cross-provider second opinion | Does rechecking with OpenAI improve on the same-provider route? | The tested variant missed the stratified criteria. Gemini 2.5 Flash remained the default for rechecks. | [85efefb][cross] |
| Prefix-to-body height ratio | Does an OCR height ratio distinguish undersized warnings? | The observed ratios overlapped across groups. The proposed cutoff never reached an end-to-end trial. | [02b20cc][initial] |
| Combined candidate review | Which of the 16 candidates improved the baseline within the evaluation criteria? | The review shipped 2,000 px upscaling. The other candidates were rejected or deferred. | [57ea3be][closure] |
| PaddleOCR | Can PaddleOCR replace Tesseract without losing accuracy or raising latency? | The cross-pair run missed the acceptance criteria. Tesseract stayed in use. | [a6bc042][survey] |
| Rotation and ground truth | Do two rotated labels fail because the verifier mishandles rotation? | Both labels contained noncompliant warning text. The ground truth was corrected. | [a6bc042][survey] |
| Qwen3-VL | Can Qwen3-VL replace the primary extractor? | The match rate fell from 71.6% to 54.4%, and median latency rose. | [a6bc042][survey] |
| Llama 4 Scout | Can Llama 4 Scout replace the primary extractor? | The match rate fell from 71.6% to 40.8%. | [a6bc042][survey] |
| Resolution and normalization order | Can a larger input or earlier contrast normalization help? | The first comparison retained 1,600 px and normalization after resizing. Later full-corpus runs supported 2,000 px. | [a6bc042][survey] |
| Thresholding and relative size | Can Otsu thresholding or body-relative size recover warning measurements? | Neither passed the targeted comparison. Missing OCR prefix tokens limited both. | [a6bc042][survey] |
| Specialist model survey | Could a task-specific model replace or assist warning OCR? | The survey found candidates for later testing. No candidate qualified to ship. | [a6bc042][survey] |
| Hosted vision model sweep | Can a hosted alternative meet the primary model's accuracy and latency criteria? | Five runs completed and one stalled. None replaced the primary extractor. | [a6bc042][survey] |
| Lanczos upscaling | Can a 2,000 px long edge recover missed warning defects? | Adversarial false passes fell from six to two, and compliant false failures fell from one to zero. | [2faa852][upscale] |
| Per-image resolution sweep | Can another long-edge setting outperform 2,000 px on the hard cases? | Individual outcomes varied by resolution. The full-corpus decision retained 2,000 px. | [a6bc042][survey] |
| Grounding DINO localization | Can a better prefix locator recover measurements on the remaining false passes? | The targeted trial found missing OCR recognition in the localized region. The locator did not resolve it. | [350bbb4][deep] |
| Supplemental crops | Do additional zoomed image crops help the extractor read damaged warnings? | Both crop variants missed the acceptance criteria. The single-image input stayed in use. | [30995c2][crops] |
| Parallel bold measurement | Can an eager parallel measurement reduce verification time? | It passed five of six criteria but missed the latency target at concurrency four. | [e856cd0][parallel] |
| Gemini 3.5 Flash | Can Gemini 3.5 Flash replace Gemini 3.1 Flash Lite? | Cross-pair median latency was 3.01 times higher. The measured accuracy intervals overlapped, so the primary stayed in place. | [052ccf4][flash] |

## Reviews and research

| Review | Question | Outcome | Commit |
| --- | --- | --- | --- |
| Experiment code audit | Which optional paths are outside the default verifier? | The audit identified OCR prompt hints, optional OCR backends, and model-routing paths for potential cleanup. | [a6bc042][survey] |
| Architecture retrospective | Which design changes would address the remaining scoring failures? | The review proposed warning localization, stratified scoring, and reference-artwork matching. Stratified scoring was adopted. | [d3ab7d4][retro] |
| Open-weight model survey | What could a local extraction and measurement pipeline use? | The survey shortlisted a vision extractor, specialist OCR, and layout and template-matching candidates for future evaluation. | [3722d81][open] |
| Closure audit | Do the docs and tests cover the verifier's decision paths? | The audit added tests and corrected documentation. The cross-pair metrics matched the preceding baseline. | [57ea3be][closure] |
| Follow-up backlog | Which improvements did the experiments and operational reviews identify? | Confidence calibration, request IDs, and upload handling landed. Later experiment results supersede the early accuracy proposals. | [350bbb4][deep] |

See the [corpus map](CORPORA.md) for fixture locations and the [benchmark harness](../benchmarks/README.md) for commands.

[initial]: https://github.com/XanderXML-Bit/label-verify/commit/02b20cc
[baseline]: https://github.com/XanderXML-Bit/label-verify/commit/a910372
[session]: https://github.com/XanderXML-Bit/label-verify/commit/719e6a6
[second]: https://github.com/XanderXML-Bit/label-verify/commit/7bee3c6
[case]: https://github.com/XanderXML-Bit/label-verify/commit/17d101c
[class]: https://github.com/XanderXML-Bit/label-verify/commit/8449092
[null]: https://github.com/XanderXML-Bit/label-verify/commit/7cd086d
[primary]: https://github.com/XanderXML-Bit/label-verify/commit/175cb16
[strata]: https://github.com/XanderXML-Bit/label-verify/commit/a91bac8
[cross]: https://github.com/XanderXML-Bit/label-verify/commit/85efefb
[closure]: https://github.com/XanderXML-Bit/label-verify/commit/57ea3be
[survey]: https://github.com/XanderXML-Bit/label-verify/commit/a6bc042
[upscale]: https://github.com/XanderXML-Bit/label-verify/commit/2faa852
[deep]: https://github.com/XanderXML-Bit/label-verify/commit/350bbb4
[crops]: https://github.com/XanderXML-Bit/label-verify/commit/30995c2
[parallel]: https://github.com/XanderXML-Bit/label-verify/commit/e856cd0
[flash]: https://github.com/XanderXML-Bit/label-verify/commit/052ccf4
[retro]: https://github.com/XanderXML-Bit/label-verify/commit/d3ab7d4
[open]: https://github.com/XanderXML-Bit/label-verify/commit/3722d81
