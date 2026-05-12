# Overnight Sprint — Project TODO

> Created 2026-05-12 after the user handed off the project for the
> night. Locked-in TODO based on every ask from the last ~10 messages.
> Sub-agent reviewed before execution started. Each item has a
> deliverable and acceptance criteria — "done" is observable.

## Hard rules

1. **Don't game the corpus.** No tuning thresholds or prompts to make
   the SVG sample numbers look better; the test must generalise.
2. **Don't break what works.** The bake-off winner (Gemini 3.1 Flash
   Lite) ships as primary. Don't change the model unless data demands.
3. **No AI slop in the final report.** Crisp, short, data-cited.
4. **Sub-agent review at the inflection points** (TODO, bench numbers,
   deferral methodology, security, doc completeness). Hermes counts as
   an outside reviewer.
5. **Every change tested.** `npx tsc --noEmit && npx vitest run` must
   pass after every meaningful commit. Playwright spot-check after UI
   changes.
6. **Honest about gaps.** If something isn't done by morning, it's in
   the final report as "still rough" — not silently omitted.

## Phase A — Foundation (lock-in)

### A1. Build this TODO doc. ✅ (you're reading it)

### A2. Have a sub-agent independently review the TODO

Acceptance: agent reports whether the plan is coherent, whether it
covers every ask in the user's last 4 messages, and flags anything
risky or missing.

### A3. Send the user the actual failing + deferred images

The user asked twice. The first per-image script ran but the output
folder was apparently empty/missing. Re-run the analysis, write the
images into `.review/t6-failures/` and `.review/t6-deferred/`, embed
2-3 representative images via multimodal Read in the final report so
the user can SEE them.

## Phase B — User-visible UX fixes (the user explicitly asked)

### B1. Loading bar with elapsed-time counter

Current: `<div className="h-full w-1/3 animate-pulse bg-blue-500">` —
no actual progress, just a pulse. User: "would prefer ... a counter
of how long since the start of the request has passed and maybe a
loading bar."

Replace with:
- Live "Verifying… 2.3 s" counter (updates every 100 ms)
- A determinate progress bar that's a smooth ease-out animation toward
  ~5 s expected duration (capped at 95 % until the response arrives)
- After 10 s, the copy changes to "Still working — larger or
  complex images take a moment."

### B2. Investigate "PASS sample sometimes returns REVIEW under brand_name"

The user saw this once but couldn't reproduce on retry. Two hypotheses:
1. Vision model's per-field confidence drifts run-to-run; on the lower
   end of that drift, brand_name confidence crosses
   REVIEW_CONFIDENCE_THRESHOLD (0.55) and downgrades the PASS.
2. The brand_name comparator is occasionally returning REVIEW for an
   exact-match case.

Action: run the PASS sample 20 times in a loop, log per-field
confidence + comparator result, identify the variance source. Fix.

### B3. Replace SVG sample images with AI-generated photos

Current: `public/samples/{pass,fail,review}.png` are SVG renders. User
wants real photos. The AI corpus has 50 candidates. Pick three from
`test-data/ai-generated/labels/`:
- PASS: a compliant front-label photo (e.g. ai-label-0001 Mill Creek
  Pilsner — verified compliant)
- FAIL: a non-compliant warning case (find one in the audit)
- REVIEW: a borderline-bold or paraphrased warning (find one)

Update samples.ts + public/samples/.

## Phase C — The corpus rerun (the big one the user demanded)

### C1. Reconcile AI ground-truth against the cross-validation report

`.review/ai-corpus-cross-validation.md` documented systematic
country_of_origin drift in Codex's ground-truth (43 of 46 drifts on
this field). Fix: per the previous report, set country_of_origin to
null where the oracle could not visibly read it; keep the producer
address separately.

Output: `test-data/ai-generated/ground-truth-corrected/*.json` with
the country_of_origin field reconciled. Document the diff in
`.review/ground-truth-reconciliation.md`.

### C2. Combine corpora

Create `test-data-combined/`:
- 90 images from `test-data-v2/labels/` + their ground-truth
- 50 images from `test-data/ai-generated/labels/` + corrected
  ground-truth
- A `manifest.json` listing all 140 image IDs and their source bucket
  (v2 / ai-generated) and degradation set

### C3. Bench harness update

`benchmarks/run.ts` accepts a `--corpus test-data-combined` argument
that knows how to route to two source dirs and merge ground-truth.
Reports accuracy separately for the v2 and ai-generated subsets so
the headline doesn't mask either side.

### C4. Run the full bake-off

13 techniques × 140 images × 1 trial = 1,820 API calls. Estimated $3-6
in spend. Use the existing bench script with `--corpus
test-data-combined --bake-off`. Wait for it. Capture per-image
outcomes (modified script writes them to disk this time so we don't
lose data).

### C5. Update MODEL-SELECTION.md §4

Replace the routine-subset numbers with the combined-corpus numbers.
Report v2-only, ai-only, and combined accuracy. Be honest if the
headline drops.

## Phase D — Error handling sweep

### D1. Structured error envelopes

Every API route returns `{ error, code, troubleshoot }` on failure
where `troubleshoot` is one actionable sentence. Apply to:
- /api/verify
- /api/extract
- /api/application/parse
- /api/verify/batch
- /api/warmup
- /api/health

### D2. Provider-down detection + auto-fallback

If Gemini returns 401/403/429/5xx during verify, catch it and:
1. Log with a request ID
2. If OPENAI_API_KEY is set, retry once against gpt-5.4-nano
3. Return result with a `fallbackUsed: true` flag

UI shows a yellow banner: "Verified using a backup model — primary
unavailable. Result may differ slightly."

### D3. Frontend status banner

On page load, hit /api/health. If `ready: false` or any required
provider is `false`, render a yellow banner at the top of the page
with the specific cause + what the user should do.

### D4. Specific error messages

- 413 image too large → tell the user the cap and offer compression
- 415 wrong MIME → list the accepted formats
- 429 rate limited → tell them retry-after seconds
- 504 vision timeout → distinguish "still warming up" from "model
  unreachable"

### D5. Tests

Add tests for each error path so a regression hits CI.

## Phase E — Deferral threshold calibration

### E1. Capture per-field confidence + correctness from C4 rerun

Modify the bench output to log, for every image × field, the
extractor's reported confidence AND whether the scorer said it was
correct vs ground truth.

### E2. Sweep threshold

Run threshold from 0.30 → 0.95 in 0.05 steps. At each step, compute:
- True-positive deferrals (correctly routed a wrong PASS to REVIEW)
- False-positive deferrals (routed a correct PASS to REVIEW — annoying)
- Missed PASS (a wrong PASS stayed PASS — dangerous)

### E3. Pick the threshold

Choose the one maximising
`tp_defer − 3 × fp_defer − 5 × missed_pass`. The 3:1 and 5:1 ratios
match a reviewer's tolerance: one annoying false-defer per three true
catches; one missed wrong-PASS per five true catches is worse.

### E4. Update REVIEW_CONFIDENCE_THRESHOLD

Replace the 0.55 hardcoded value with the calibrated value. Document
the curve in `docs/DEFERRAL-CALIBRATION.md`.

## Phase F — Two-pass Gov Warning text validator

### F1. Implement canonical-form re-comparison

When the model's `raw_text` differs from the federal canonical text:
1. First-pass: current edit-distance comparison
2. Second-pass: token-level alignment against the canonical text;
   if alignment recovers a 95 %+ match, classify as
   "model-paraphrased" (route to REVIEW with note "model may have
   misread the warning text") rather than FAIL
3. Real non-compliance (alignment score < 80 %) routes to FAIL

### F2. Tests

Add tests for: identical text → PASS, single-word paraphrase →
REVIEW (with reason "model-paraphrased"), actual non-compliance →
FAIL, missing entire warning → FAIL.

## Phase G — Quality of life + nice-to-have

### G1. Batch cap → 1000

`MAX_BATCH_SIZE=1000` in .env.example and the route default. Test on
a 500-image manifest synthetically.

### G2. Real-photo sample (covered in B3)

### G3. Custom domain — DNS-only routing via Cloudflare → Vercel

If the user gives a hostname before sprint completes, add it to
Vercel. Otherwise document the procedure in DEPLOYMENT.md.

### G4. CSP header

Add a `Content-Security-Policy` header to the layout so the project
hits standard security checklists. Tight default: `default-src
'self'; img-src 'self' blob: data:; script-src 'self' 'unsafe-inline'`.

## Phase H — Sub-agent review checkpoints

### H1. Hermes — methodology review of the rerun

Use the local Hermes CLI (`hermes chat -q "..." -Q`) to ask:
"Given the combined-corpus bake-off result [paste the numbers],
do you spot any methodology issues? Is the per-stratum accuracy
reporting sufficient? Is the Government Warning FN rate
interpretation correct?"

### H2. Hermes — review of the deferral calibration

Same pattern. Ask whether the precision/recall trade-off weights
(3:1 fp_defer, 5:1 missed_pass) are defensible for a regulatory
review tool.

### H3. Sub-agent — security pass

Spawn a Claude sub-agent to audit the security posture and look for
issues the previous pass missed (dependency CVEs, image-bomb
defense, CSP, request-ID propagation).

### H4. Sub-agent — outside-perspective UX critique

Same agent format as before. Critique the post-cleanup UI.

## Phase I — Doc + code cleanup

### I1. Outdated doc references

`docs/APPROACH.md` still references the four-contender T1+T4+T6+C1
language. Update to the 13-variant result. Same in any other doc that
quotes the pre-bake-off plan.

### I2. Dead code

- `SettingsPanel.tsx` — kept as a dead file. Decide: delete or
  restore behind a debug flag. (Earlier I said "keep for future
  operator use." Reconsider after sub-agent review.)
- `model-modes.ts` — keep for the bench harness, but remove any
  references in the runtime path that are dead.
- Unused imports / commented-out code across `src/`.

### I3. Lint cleanup

The `@typescript-eslint/consistent-type-imports` warnings on a few
files (api-verify, api-extract, lib/verify) — convert to type-only
imports to clear the warnings.

## Phase J — The flagship final report

### J1. README rewrite

Per the structure I proposed earlier. Sections:
1. What this is (one paragraph)
2. Live demo + screenshots
3. The result we hit (with the honest combined-corpus number)
4. How to use it
5. How it works under the hood
6. Methods we considered and rejected (table from ALTERNATIVES.md)
7. Models we benchmarked and why we chose (from MODEL-SELECTION §4)
8. Procedure (pre-registered, falsified, calibrated)
9. Numbers (corpus size, accuracy, latency, cost, line counts, test
   counts)
10. Beyond the brief
11. Security posture
12. Self-hosting
13. What's still rough

No AI slop. Target 1500-2500 words.

### J2. Send the failing + deferred images in the report

Embed 2-3 specific images via multimodal Read so the user can
visually assess "is this a reasonable failure or an obvious miss."

## Phase K — Final deploy + verify

### K1. All tests green

`npx tsc --noEmit && npx vitest run` — zero failures, zero errors.

### K2. Playwright sweep

Re-run the e2e tests against the live URL after redeploy. Document
any failures.

### K3. Vercel deploy

`vercel deploy --prod` — verify `/api/health` reports the latest
commit + ready: true + providers configured.

### K4. Live URL smoke

Hit each route via curl, confirm 200 or expected status. Include
in the final report.

### K5. The final report message to the user

One message, comprehensive, no AI slop, includes:
- What was done
- Headline numbers (honest)
- The failing/deferred images
- What's still rough
- Specific things the user might want to look at on the live site
