# Wave 35d — eager parallel `measureRelativeBold` for the Government Warning validator

> **Status: FALSIFIED on the latency gate at bench concurrency 4.
> No code change ships to `main`.**
>
> The deterministic invariant (verdict bucket per record) is byte-
> identical pre/post the change — exactly as predicted, because the
> bold measurement is a pure function of (imageBuffer, prefixWords,
> bodyWords) and the change only moves WHEN it runs, not WHAT it
> computes. However, the experiment's pre-registered "no latency
> regression" gate was violated by +147 ms mean total time across
> N=2 paired runs, root-caused to CPU contention between the eager
> sharp/SWT pipeline and concurrent Tesseract workers in the bench
> harness. Per Apex §13 the variant is falsified; per the user's
> "never do anything regressive" directive the experiment does not
> ship.
>
> The implementation code lives only on the experiment branch
> `chore/wave-35d-parallel-bold-measurement` (preserved on origin
> as audit-trail artifact). This PR carries the writeup + bench
> artifacts only.

## §2.3 Hypothesis matrix

| ID | Hypothesis | What would falsify it | Expected magnitude | Outcome |
|---|---|---|---|---|
| H35d | Firing `findPrefixWords` + `findBodyWords` + `measureRelativeBold` eagerly as soon as `ocrPromise` resolves (parallel with the tail of the vision call), and passing the pre-computed result into `validateGovernmentWarning`, shaves the classical-CV bold-measurement pass (50–150 ms) off the critical path of the median verify (where OCR finishes before vision). | (a) ≥1 record-level bucket diff vs baseline (would imply non-byte-identical computation); OR (b) mean total time regression in either direction beyond noise band; OR (c) p95 regression beyond noise band. | Best plausible: −50 to −150 ms on median total; 0 record diffs. | (a) ✓ PASSED — 0 / 340 record diffs (verdict-byte-identical, as the math predicted). (b) ❌ FAILED — mean total **+147 ms** across N=2 paired runs; per-record paired median **+125 ms**. (c) Inconclusive — p95 noise band is wide enough that the +700 ms change is plausibly noise. |

The accuracy half of the hypothesis (no record diffs) was correctly predicted. The latency half was wrong because of an unmodeled CPU-contention effect at concurrency 4.

## §13 Pre-registered decision rule

| Hard criterion | Threshold | Wave-35d result | Pass? |
|---|---|---|---|
| record-level bucket diffs vs baseline | must be 0 | 0 / 340 | ✓ |
| `compliant.fp-on-correct` | must NOT increase | 0 → 0 | ✓ |
| `compliant.false-fail` | must NOT increase | 0 → 0 | ✓ |
| `adversarial.fp-on-correct` | must NOT increase | 3 → 3 | ✓ |
| pass-rate | must NOT decrease | 70.41% → 70.41% | ✓ |
| mean total latency | must NOT regress beyond noise band | baseline 5691 ms → wave-35d 5838 ms (+147 ms = +2.6 %) | ❌ |

**Verdict: 5 of 6 hard criteria pass. The single failing criterion is the latency-no-regression gate — which is the entire reason the experiment was run.**

## Bench data (full)

Source files (preserved on the experiment branch):

- `benchmarks/results/wave35-supplemental-crops/baseline-run1.json` — pre-experiment baseline (post-wave-35c main `e456f7e`)
- `benchmarks/results/wave35-supplemental-crops/baseline-run2.json`
- `benchmarks/results/wave35d-parallel-bold/wave35d-run1.json`
- `benchmarks/results/wave35d-parallel-bold/wave35d-run2.json`

### Mean per phase (N=2 runs each, 340 cross-pair tasks per run, concurrency 4)

| Phase | Baseline | Wave-35d | Δ |
|---|---:|---:|---:|
| preprocess | 212 ms | 240 ms | +28 ms |
| ocr | 1684 ms | 1905 ms | **+221 ms** |
| vision | 2515 ms | 2423 ms | −92 ms |
| matching | 416 ms | 457 ms | +41 ms |
| **total** | **5691 ms** | **5838 ms** | **+147 ms** |

### Verdict accuracy invariant

- baseline-run1 vs baseline-run2 (Gemini at temp 0.0): 0 record diffs.
- wave-35d-run1 vs baseline-run1: **0 record diffs**.
- wave-35d-run2 vs baseline-run1: **0 record diffs**.

The bold measurement IS byte-identical pre/post, as the math predicted. Whether you compute it inside `validateGovernmentWarning` or in an eager promise chained off `ocrPromise`, the inputs (image buffer, prefix words from `findPrefixWords`, body words from `findBodyWords`) are byte-identical and the function is deterministic. Verdicts cannot change. They didn't.

## Root cause: CPU contention at bench concurrency 4

Vision latency actually **improved** slightly (−92 ms mean) — consistent with the eager bold completing during the vision wait and not stealing wall-clock from the critical path on that record. But OCR latency went **up by 221 ms mean**, more than offsetting the vision win.

The OCR regression is the surprise. Tesseract.js runs in a WASM worker; the eager bold uses `sharp` + a JS-side SWT computation. They are separate compute pipelines but they share the Node event loop and a single CPU on the bench host. At concurrency 4 (4 simultaneous verifies), there are now 4 in-flight eager-bold pipelines competing with 4 in-flight Tesseract workers + 4 in-flight sharp preprocesses. The cumulative CPU pressure slows every concurrent operation.

**Production-realism caveat**: Vercel functions execute one verify per instance — concurrency 1, not concurrency 4. The contention story doesn't apply in production. The eager bold would likely save 50–150 ms in production. But the bench protocol is `--concurrency 4` per BENCH-PROTOCOL.md, and pre-registered criteria evaluated under bench conditions are the gate. Cherry-picking a bench config to make a change look favourable violates Apex §13. Reject.

## What worked (and stays as lessons)

- **The byte-identical-verdict prediction was correct.** This validates the architectural intuition that "move the bold computation earlier" cannot regress accuracy. Future refactors of when the bold runs can rely on this invariant.
- **The validator API extension** (`ValidatorOcrContext.boldMeasurement?: BoldMeasurement | null`) is a clean backwards-compatible enhancement. When the field is undefined (default), the validator computes internally — identical to today. Even though we're not shipping the orchestrator caller for this field, the API surface itself is harmless if anyone needs it in the future.

## What didn't work

- **CPU contention at the bench concurrency.** Multi-pipeline parallelism on a single CPU helps wall-clock only when ONE pipeline is CPU-bound and others are IO-bound — vision is IO-bound (waiting on Gemini's response), Tesseract is CPU-bound, sharp+SWT is CPU-bound. Adding more CPU-bound work doesn't help; it crowds.

## What I'd consider for a v2 attempt

Listed for the audit trail; **none of these is currently planned**:

1. **Gate the eager bold on `process.env.LV_FAST_BOLD === "1"`.** Lets production benefit while the bench (which doesn't set the env) stays unaffected. Smells of cherry-picking. Could be defensible with: "production runs at concurrency 1; bench at concurrency 4; the same code path measured under each."
2. **Switch from sharp-based SWT to a WASM SWT module** that releases the JS thread. Removes the contention. Substantial dependency hunt; non-trivial.
3. **Tail-of-vision parsing first.** Even simpler: when the vision response arrives, parse `prefix_bbox` + `prefix_appears_bold` + `prefix_appears_caps` IMMEDIATELY and start the bold computation; let the full JSON parse finish later. Same idea as eager bold, but triggered on vision-arrival not OCR-arrival. Likely identical contention problem.

## §15 completion-gate checklist for the falsified PR

- [x] N=2 deterministic bench run on baseline + wave-35d.
- [x] Record-level bucket-diff analysis (0 diffs confirmed).
- [x] Mean per-phase latency analysis (regression source identified: OCR +221 ms).
- [x] Hypothesis-matrix outcome column filled in.
- [x] `CHANGELOG.md` "wave 35d falsified" section appended.
- [x] Variant code held on `experiment` branch only; no code change on `main`.
- [x] Bench JSON artifacts pinned at `benchmarks/results/wave35d-parallel-bold/`.
- [x] Production-realism caveat documented (the bench config matters; production might tell a different story).
- [x] Branch `chore/wave-35d-parallel-bold-measurement` preserved on origin as audit-trail artifact; can be deleted after 30+ days.

## Apex framework anchors

- **§2.3 hypothesis matrix** — pre-registered before code change.
- **§13.7 noise characterization** — N=2 deterministic runs per arm. Run-to-run baseline noise of σ ≈ 245 ms means the +147 ms mean is roughly 0.6 σ; not "outside the noise band" on a strict 2σ rule. But the *per-record paired* median of +125 ms is a stronger signal — paired tests remove between-run noise.
- **§13 pre-registered decision rule** — 5 of 6 criteria pass; the failing criterion is the latency-no-regression gate.
- **§13.8a claim ledger** — single claim: "this experiment is falsified at bench concurrency 4; here is the data."
- **§12.3 hypercritical self-audit** — performed before merge: see "Root cause" section. The contention effect was not anticipated in pre-registration.
- **§15 completion gates** — all checklist items above ticked.

## Engineering hours + API spend (actual)

- Implementation + unit tests: ~1 hour.
- Bench runs (N=2 each on baseline + experiment, sharing baseline files from wave-35c): ~25 min wall-clock.
- Gemini API spend: ~$0.17 (340 records × 2 runs × $0.00025).
- Writeup: ~30 min.
- **Total: ~2 hours, ~$0.17 API spend.** Cheap falsification.
