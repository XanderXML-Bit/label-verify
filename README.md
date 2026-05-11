# Label Verify

AI-powered verification of beverage label artwork against declared
application data. A prototype for the U.S. Department of the Treasury,
Alcohol and Tobacco Tax and Trade Bureau (TTB).

**Live demo:** _(deploys to `labelverify.zendren.net` — TBD)_
**Status:** Foundation in place; benchmark + implementation underway.

## What it does

Given a label image (or a batch of up to 300) plus the values declared on
the COLA application, Label Verify returns a structured pass/fail verdict
for each regulated field:

- Brand name (fuzzy match)
- Class / type designation
- Alcohol by volume
- Net contents
- Government Warning statement — strict, including bold + all-caps prefix
- Producer / importer name and address
- Country of origin

End-to-end target: **≤ 5 seconds per label** (the previous vendor's
30–40 s was unworkable).

## Why this layout

This repo is documentation-first because the decisions matter more than the
code for a take-home. Read in this order:

1. [`docs/evaluation-brief.md`](docs/evaluation-brief.md) — the requirements
   that drive everything. The "bible."
2. [`docs/ARCHITECTURE.md`](docs/ARCHITECTURE.md) — system design and stack
   choices with justification.
3. [`docs/APPROACH.md`](docs/APPROACH.md) — the scientific comparison
   framework we use to pick the verification engine instead of guessing.
4. [`docs/TEST-STRATEGY.md`](docs/TEST-STRATEGY.md) — how we generate
   labels with known ground truth so accuracy claims are defensible.
5. [`docs/UI-SPEC.md`](docs/UI-SPEC.md) — UI/UX spec for a non-technical
   reviewer audience.
6. [`docs/DEPLOYMENT.md`](docs/DEPLOYMENT.md) — how the live URL is built
   and maintained.
7. [`TODO.md`](TODO.md) — prioritized backlog through 2026-05-18.

## Quick start (local)

```bash
git clone https://github.com/XanderXML-Bit/label-verify.git
cd label-verify
cp .env.example .env.local       # fill in keys (see docs/DEPLOYMENT.md §3)
npm install
npm run dev                       # http://localhost:3000
```

Other useful scripts:

```bash
npm run gen:corpus     # regenerate the synthetic test-label set
npm run bench          # run all extractor benchmarks
npm run bench:smoke    # 20-image subset; runs in CI
npm run typecheck
npm run test
```

## Project structure

```
label-verify/
├── README.md
├── TODO.md
├── docs/                  # The "why" — read these first
├── src/
│   ├── app/               # Next.js App Router (UI + API routes)
│   ├── lib/
│   │   ├── ocr/           # OCR adapters (Tesseract, etc.)
│   │   ├── vision/        # Vision-model adapters
│   │   ├── matching/      # Fuzzy + strict field comparators
│   │   └── validation/    # Regulated-field validators (Gov Warning, etc.)
│   └── tests/             # unit + integration
├── benchmarks/
│   ├── techniques/        # extractor implementations under test
│   └── results/           # committed JSON + Markdown of past runs
├── test-data/
│   ├── labels/            # synthetic + real test images
│   └── ground-truth/      # one JSON per image
└── scripts/
```

## Tech stack

- **Next.js 15** (App Router) + **TypeScript** strict
- **Tailwind** + **shadcn/ui** for accessible UI primitives
- **sharp** for image preprocessing
- **tesseract.js** for local OCR
- **OpenAI / Anthropic / OpenRouter** for hosted vision
- **Florence-2** / **moondream2** as network-free fallback
- **vitest** for tests
- **Vercel** for deployment

Each choice is justified in
[`docs/ARCHITECTURE.md`](docs/ARCHITECTURE.md) §2.

## How we pick the verification engine

We benchmark, then decide. Ten candidate techniques (and six combinations)
are evaluated against a 100+ label corpus on accuracy, latency, cost, and
network-independence. See
[`docs/APPROACH.md`](docs/APPROACH.md) for the methodology and
[`benchmarks/results/`](benchmarks/results/) for the data once runs land.

## Constraints we are designing around

- **5-second budget** — the previous vendor took 30–40 s and was rejected.
  See latency budget in [`docs/ARCHITECTURE.md`](docs/ARCHITECTURE.md) §4.
- **Mixed-tech-comfort reviewers** — the UI is designed for a 55-year-old
  who has never seen the app before. See
  [`docs/UI-SPEC.md`](docs/UI-SPEC.md).
- **Network-restricted environments** — government networks block many
  third-party domains, so a local-model fallback path is part of the
  design from day one.

## License

MIT — prototype, no warranty, etc.
