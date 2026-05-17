# Contributing

LabelVerify is a prototype, so contributions during the
review window are unlikely — but if a future self-hoster wants to
extend it, this doc covers the three most common extensions plus the
CI gates a change has to pass.

## Setup

```bash
git clone https://github.com/XanderXML-Bit/label-verify.git
cd label-verify
cp .env.example .env.local
# Fill in at least GOOGLE_API_KEY. OPENAI_API_KEY enables the fallback.
npm install
npm run dev          # → http://localhost:3000
npm run test         # full vitest suite (~699 tests across 74 files, ~10 s)
```

If `npm install` fails on Windows due to native module compile, you
may need to install Build Tools first:
```powershell
npm install --global windows-build-tools
```

## Repo layout

- `src/` — Next.js 15 App Router code.
  - `app/` — UI pages, route handlers, components.
  - `lib/` — pure logic. `verify.ts` is the orchestrator; `matching/`
    has the per-field comparators; `vision/` has model adapters;
    `validation/` has the Government Warning subscores.
  - `tests/` — vitest specs co-located by concern (not co-located by
    file). UI tests under `tests/ui/`.
- `benchmarks/` — bake-off harness (`run.ts`), scorer, technique
  registry. Run with `npm run bench:bakeoff` or `npm run bench:routine`.
- `docs/` — flagship report sources + handoff docs.
- `test-data*/` — ground-truth and label images.
- `scripts/` — one-shot helpers (generate corpora, calibrate
  thresholds, cross-validate ground truth).

## Common extensions

### 1. Add a new vision provider

Three files touch:

1. **Provider adapter** in `src/lib/vision/<name>.ts`. Implement the
   `Extractor` interface from `src/lib/vision/types.ts`:
   ```ts
   class MyProviderExtractor implements Extractor {
     readonly id: string;
     readonly networkRequired = true;
     readonly modelVersion: string;
     async extract(image: Buffer): Promise<ExtractorResult> {
       /* call your API; map to ExtractedFields; compute cost. */
     }
   }
   ```
   Use the EXTRACTION_PROMPT in `src/lib/vision/prompt.ts` verbatim
   — it has the prompt-injection hardening baked in.
2. **Technique registration** in `benchmarks/techniques.ts`. Add a
   new entry to `BUILTIN_TECHNIQUES`:
   ```ts
   { id: "T99", networkRequired: true, build: async () => {
       const mod = await import("../src/lib/vision/my-provider");
       return new VisionExtractorRunner("T99", new mod.MyProviderExtractor({ apiKey: process.env.MY_API_KEY! }), false);
     } },
   ```
3. **Pricing** for the cost column in the bake-off report. The
   adapter's `extract()` should return `cost: { inputTokens, outputTokens, costUsd }`.

Run `npm run bench:routine -- --technique T99` to validate. Cost-
conscious: routine = 15-label subset.

### 2. Add a new ground-truth corpus

1. Create `test-data-yourname/labels/` and
   `test-data-yourname/ground-truth/`.
2. Each label needs a sibling JSON ground-truth file conforming to
   `GroundTruth` in `benchmarks/scorer.ts` (see
   `docs/archive/CODEX-HANDOFF.md` §3 for the canonical schema).
3. Validate with `npx tsx scripts/validate-corpus.ts test-data-yourname`.
4. Run a bake-off pass:
   `npm run bench -- --corpus test-data-yourname --technique T6 --trials 1`.

The bench harness automatically derives stratification keys
(`beverage_type`, `condition`) from each ground-truth file. Wilson
95% CIs and ID/OOD partitioning come for free.

### 3. Add a new benchmark candidate

If you want to test against a corpus subset (e.g. "all PDFs only"),
add a selector function in `benchmarks/routine.ts` and a new CLI
flag in `benchmarks/run.ts`'s `parseArgs`. The bench harness reads
the selector via the `--routine` / `--smoke` precedence rules
(documented inline near `parseArgs`).

## The prompt-hash contract

`src/lib/vision/prompt.ts` exports `EXTRACTION_PROMPT` and `getPromptHash()` (sha256
of the prompt string + schema shape). Every extractor reports the hash alongside
its result. This lets a reviewer prove that two benchmark runs used
the same prompt — critical when comparing accuracy numbers across
git revisions.

**If you change the prompt, the hash MUST update.** The hash is
computed at module load — the runtime checks itself. CI fails on
hash mismatch with the committed snapshot.

## CI gates

Every PR must pass:

```bash
npm run typecheck    # tsc --noEmit, zero output expected
npm run lint         # next lint, only pre-existing warnings allowed
npm run test         # full vitest suite (~699 tests across 74 files, ~10 s)
```

The `bench:routine` script runs in a separate workflow on demand
(it costs ~$0.30 per run, so it doesn't fire on every PR). Trigger
it via the GitHub Actions UI when a change might affect accuracy.

## Code conventions

- TypeScript strict mode; **no `any`** in production code paths.
- Tests are vitest, not jest — keep imports consistent.
- React 19 server components by default; `"use client"` only when
  needed (browser-only APIs, state, event handlers).
- Tailwind for styling; no separate CSS modules.
- ESM-only — no `require`. Use dynamic `import()` for code-split.
- Prompts and schemas live next to the code that uses them, never
  in a top-level `prompts/` or `schemas/` folder.
- Comments explain WHY, not WHAT. Bias toward short codepaths over
  long abstractions.

## Where to ask questions

- Architecture: `docs/ARCHITECTURE.md`.
- Why the threshold is 0.55: `docs/MODEL-SELECTION.md` §3, plus the
  in-code comment block at `src/lib/verify.ts:108`.
- What the verifier gets wrong: `docs/FAILURE-MODES.md`.
- Open items: `docs/REMAINING-IMPROVEMENTS.md`.
- Security: `SECURITY.md`.

If those don't answer the question, open a GitHub issue.
