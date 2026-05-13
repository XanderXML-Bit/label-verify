# LabelVerify CLIs

LabelVerify ships **three** command-line interfaces. Pick the one that
matches what you're trying to do:

| CLI | File | Talks to | When to use |
|---|---|---|---|
| **Operator CLI** | `bin/labelverify.ts` | the backend modules **in-process** | scripted bulk runs, CI, reviewer reproducibility, no browser / API server |
| **Web-app driver CLI** | `bin/labelverify-web.ts` | the deployed HTTP API (or local `npm run dev`) | smoke-testing production, dogfooding the multipart contract, CLI front-end for anyone who'd rather not open a browser |
| **Benchmark CLI** | `bin/labelverify-bench.ts` | the backend modules in-process, against the whole corpus | accuracy + speed measurement against the canonical 170-image corpus, both with correct ground-truth and with deterministically-perturbed (wrong) declared data |

They all read `.env.local` (if present) and accept `--json` for machine output.

## Why three CLIs?

The two non-benchmark CLIs deliberately exercise **different failure
surfaces**:

- The **operator CLI** catches regressions in the core pipeline
  (`verifyLabel`, `parseApplication`, the comparators, the GW
  validator) without the Next.js + browser machinery in the way.
- The **web-app driver CLI** catches regressions in the *route* layer
  (multipart parsing, MIME handling, rate-limiting, serverless
  cold-start) — the same layer a browser touches. Shipping it means
  a class of GUI-only bugs (like the 2026-05-13 Vercel serverless
  instance-isolation 404) gets caught by a non-browser test surface
  *before* any user reports them.

The **benchmark CLI** is a separate tool because it needs:

- Iteration over the full corpus with concurrency control
- Per-call timing breakdowns
- A deterministic perturbation generator for the "wrong-declared"
  side of the cross-pair benchmark
- Multi-stratum reporting (pass-rate, fail-or-review-rate, P50/P95)

It would be confusing to mix that with the per-image operator CLI.

---

## Operator CLI — `bin/labelverify.ts`

```bash
npm run cli -- <command> [args] [--json]
```

| Command | Args | Description |
|---|---|---|
| `verify`     | `<image> <app-or-manifest>` | Verify one label against application data (PDF/JSON/CSV/MD/TXT/DOCX/image-of-form). Exits 0 on PASS, 1 on FAIL/REVIEW. |
| `extract`    | `<image>`                   | Extract fields + GW subscore from a label. No verdict. Useful when no application data is available. |
| `parse-app`  | `<application-path>`        | Parse an application file into a declared-fields payload. Prints fields, source, warnings, confidence. |
| `batch`      | `<folder>`                  | Verify every image in `<folder>`, auto-paired with same-stem application files. Mirrors the GUI's batch flow. |
| `samples`    | —                           | List the three bundled samples the GUI offers (pass/fail/review). |
| `health`     | —                           | Probe service readiness (checks API keys, env config). Exits 1 if not ready. |

```bash
# Examples
npm run cli -- verify public/samples/pass.jpg path/to/application.json
npm run cli -- extract public/samples/pass.jpg --json
npm run cli -- batch ./labels-folder/
npm run cli:health
npm run cli:samples
```

Short scripts in `package.json`:
- `npm run cli:health` → `tsx bin/labelverify.ts health`
- `npm run cli:samples` → `tsx bin/labelverify.ts samples`

---

## Web-app driver CLI — `bin/labelverify-web.ts`

Same six commands, but it speaks HTTP to a running web app instead of
calling backend modules in-process.

```bash
npm run cli:web -- <command> [args] [--json] [--local] [--base-url <url>] [--timeout <ms>]
```

| Flag | Effect |
|---|---|
| `--base-url <url>` | Hit a different host. Default `https://label-verify-six.vercel.app`. |
| `--local`          | Shorthand for `--base-url http://localhost:3000` (use with `npm run dev`). |
| `--json`           | Machine-readable JSON output. |
| `--timeout <ms>`   | Per-request HTTP timeout. Default 90 000. |
| `-h`, `--help`     | Help. |

```bash
# Smoke-test production
npm run cli:web -- health

# Verify against a local dev server
npm run cli:web -- verify public/samples/pass.jpg path/to/application.json --local

# Drive a batch verify on the hosted API
npm run cli:web -- batch ./labels-folder/ --base-url https://your-deploy.vercel.app
```

Short scripts:
- `npm run cli:web:health` → health probe against the default deploy
- `npm run cli:web:samples` → list the bundled sample affordances

### Exit codes (both CLIs)

| Code | Meaning |
|---|---|
| 0 | success / verdict=pass / health=ready |
| 1 | network or HTTP error, verdict=fail or review, or health=not-ready |
| 2 | invalid CLI arguments |

---

## Benchmark CLI — `bin/labelverify-bench.ts`

```bash
npm run bench:cross-pair -- [--limit N] [--concurrency K] [--out path.json] [--json]
```

Iterates every label in `test-data-combined/labels/` against both:
1. its **correct** ground-truth (from `test-data-combined/ground-truth/<id>.json`)
2. a **deterministically-perturbed** declared payload (from
   `test-data-combined/declared-wrong/<id>.json`)

Reports per-image timings (preprocess / OCR / vision / matching / total),
verdict, image-quality, and aggregate metrics:

- **Pass-rate on correct GT** — measures false-negative rate (compliant
  labels mis-flagged as fail/review).
- **Fail-or-review-rate on wrong GT** — measures the *useful* signal of
  the pipeline (it catches mismatches).
- **P50 / P95 latency** end-to-end.
- **By-category breakdown** if `gov_warning_case` is present in GT.

```bash
# Regenerate the wrong-declared set (idempotent, deterministic)
npm run bench:perturb

# Fast 10-image smoke
npm run bench:cross-pair -- --limit 10

# Full 170-image bake-off, JSON output to file
npm run bench:cross-pair -- --concurrency 4 --out bench-results.json --json
```

---

## Testing the CLIs

| Test file | Coverage |
|---|---|
| `src/tests/cli.test.ts`               | Operator CLI: help, arg parsing, samples, health (offline commands) |
| `src/tests/cli-web.test.ts`           | Web-app driver: help, arg parsing, samples (offline commands) |
| `src/tests/bench-cross-pair.test.ts`  | Perturbation determinism, bench CLI help + arg smoke |

The network-touching paths (`verify` / `extract` / `batch` against a
real backend) are exercised by the Playwright E2E suite (`e2e/`) and
the live smoke workflow (`.github/workflows/e2e-live.yml`) — not by
the vitest suite, so unit tests stay fast and offline-safe.
