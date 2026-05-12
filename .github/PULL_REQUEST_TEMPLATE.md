<!-- Thanks for opening a PR! Keep this tight — the reviewer is busy. -->

## Summary

<!-- 1–3 sentences. What does this change and why? Link the TODO.md item if any. -->

## Evaluation criterion served

<!-- Which R1–R8 from docs/evaluation-brief.md does this PR move the needle on? -->
<!-- Examples: R3 (Gov-Warning accuracy), R5 (latency), R7 (UI for non-technical reviewer). -->

- [ ] R1 — correctness on declared-field matching
- [ ] R2 — image-quality vs. compliance split
- [ ] R3 — Gov-Warning strict validation (27 CFR §16.21 + §16.22)
- [ ] R4 — batch throughput / SSE per-item streaming
- [ ] R5 — 5-second end-to-end latency budget
- [ ] R6 — graceful degradation on network restrictions
- [ ] R7 — UI for a non-technical reviewer
- [ ] R8 — public, HTTPS-accessible demo URL
- [ ] N/A — docs / infra / chore

## Test plan

- [ ] `npm run typecheck` clean
- [ ] `npm run lint` clean
- [ ] `npm run test` passes locally
- [ ] Manual UI smoke: single verify + batch verify on a known-good label
- [ ] `npm run bench:smoke` run **if any extractor / OCR / scorer code changed**
- [ ] Updated docs (`docs/*.md`, `README.md`) if behavior changed
- [ ] No new secrets or API keys committed

## Screenshots / output

<!-- For UI changes, drop a before/after. For bench changes, paste the relevant row from benchmarks/results/*.md. -->

## Notes for the reviewer

<!-- Anything tricky, intentional trade-offs, or follow-ups deferred. -->
