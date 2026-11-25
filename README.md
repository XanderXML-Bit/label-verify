# Label Verify

[![CI](https://github.com/XanderXML-Bit/label-verify/actions/workflows/ci.yml/badge.svg?branch=main)](https://github.com/XanderXML-Bit/label-verify/actions/workflows/ci.yml)
[![Post-deploy smoke](https://github.com/XanderXML-Bit/label-verify/actions/workflows/post-deploy-smoke.yml/badge.svg?branch=main)](https://github.com/XanderXML-Bit/label-verify/actions/workflows/post-deploy-smoke.yml)

> Independent prototype that checks labels against TTB labeling rules. Label Verify compares beverage labels with Certificate of Label Approval (COLA) application data. The public demo runs three bundled samples without model calls or file uploads.

[Open the demo](https://label-verify-six.vercel.app) and choose the Pass, Fail, or Review sample to see the evidence behind its verdict.

![Offline demo showing a beer label, a Pass verdict, and the Government Warning result](docs/screenshots/desktop.png)

## What it does

- Compares label text with the declared brand, class, alcohol content, net contents, producer, and country of origin.
- Checks the Government Warning for required text, capitalization, bold type, and minimum size.
- Returns Pass, Fail, or Review with reasons by field. Review flags evidence that needs a human check.
- Accepts single or batch uploads in self-hosted live-model mode. Batch input can pair files by filename or read declared data from a manifest.

## How it works

The demo takes a sample ID and looks up its recorded extraction. The self-hosted pipeline uses a vision model to extract fields and optical character recognition (OCR) to help measure warning text. Both modes run the extracted fields through the same application-data comparators and warning checks.

## Results

A recorded live-model cross-pair benchmark evaluated 170 synthetic and AI-generated labels against correct and deliberately altered application data.

| Application data | What the benchmark counted | Result |
| --- | --- | ---: |
| Correct | Verdict matched the expected Pass or Fail | 70.41% |
| Deliberately altered | Verdict was Fail or Review | 100% |

Two verification errors were excluded from the rates. See the [recorded run](benchmarks/results/wave35-supplemental-crops/baseline-run1.json), [benchmark protocol](docs/BENCH-PROTOCOL.md), and [model selection](docs/MODEL-SELECTION.md).

## Run it locally

```bash
# Prereqs: Node.js ≥ 20.9.0, git
git clone https://github.com/XanderXML-Bit/label-verify.git
cd label-verify
```

Install from the lockfile on Linux x64, the platform used in CI:

```bash
npm ci
```

On macOS, use `npm ci --force` to bypass the Linux-only Rollup package's platform check.

```bash
npm run dev
```

Open [localhost:3000](http://localhost:3000) and choose a sample. The default setup uses the recorded samples. Follow the [deployment guide](docs/DEPLOYMENT.md) to enable live models and uploads.

## Tests

```bash
npm run typecheck
npm run lint -- --max-warnings=0
npm run verify:claims
npm test
npm run build
```

Vitest covers the field comparators, warning validator, API routes, and browser components. The claims check compares selected documentation claims with code and stored results. Run the [Tesseract-only benchmark](benchmarks/README.md) to check the OCR baseline without a model API key:

```bash
npm run bench:routine -- --corpus test-data-v2 --technique T1
```

## Architecture

Label Verify uses Next.js App Router, React, TypeScript, and Tailwind CSS. It uses sharp for image preprocessing and Tesseract.js for OCR.

| Area | Entry point |
| --- | --- |
| Upload and sample UI | [Page](src/app/page.tsx) |
| HTTP interface | [OpenAPI specification](docs/openapi.yaml) |
| Verification pipeline | [Verifier](src/lib/verify.ts) |
| Benchmarks and fixtures | [Benchmark runner](benchmarks/run.ts) and [corpus map](docs/CORPORA.md) |

See the [architecture guide](docs/ARCHITECTURE.md), [CLI reference](docs/CLI.md), and [security policy](SECURITY.md) for implementation details.

## Limitations

The benchmark uses generated labels. Its scores do not estimate performance on submitted COLA applications. Image blur, glare, and occlusion can require manual review. Label Verify covers a subset of labeling rules, and reviewers make the final compliance decision.

## License

The repository has no `LICENSE` file.
