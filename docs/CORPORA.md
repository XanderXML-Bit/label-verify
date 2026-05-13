# Test corpora

The repo carries multiple image / ground-truth directories. This is
the canonical map.

| Directory | Images | What it is | Use it for |
|---|---:|---|---|
| `test-data-combined/` | 170 | **Canonical superset.** All `syn-*` + `deg-*` SVG renders from `test-data-v2/` ∪ all `ai-label-*` photo-realistic renders from `test-data/ai-generated/`. Ground-truth files in `test-data-combined/ground-truth/`. | Default corpus for every benchmark. **Use this.** |
| `test-data-v2/` | 90 | Strict subset of `test-data-combined/` (the `syn-*` + `deg-*` half only). Includes `routine-manifest.json` documenting the 15-image routine subset. | Backward-compat for the `routine.ts` bake-off. Subset of canonical; not separately maintained. |
| `test-data/` | 90 | **Legacy v1 corpus.** Same filenames as v2 with different image bytes (v2 was a re-render). The 78 ground-truth corrections from the 2026-05-12 accuracy wave were applied to v2 / combined, NOT back-ported to v1. | Historical reference only. Do NOT use for benchmarks (the GT is partially-incorrect post-correction wave). |
| `test-data/ai-generated/` | 80 | AI-photo-realistic source corpus, with several versioned GT directories (`ground-truth/`, `ground-truth-v2/`, `archived-unmanifested-labels/`, `validation-report.md`). The latest GT for these is also mirrored into `test-data-combined/ground-truth/`. | Provenance for the AI-label half of `test-data-combined/`. |
| `test-data-combined/declared-wrong/` | 170 | Programmatically-perturbed declared payloads — same `id` as the GT, but with brand_name swapped, ABV shifted +2.0pp (out-of-tolerance for beer), class swapped to a non-alias sibling, ×2 net_contents, country swapped to non-USA. Regenerate via `npm run bench:perturb`. | The "wrong-declared" side of the cross-pair benchmark (`npm run bench:cross-pair`). |
| `public/samples/` | 2 | Two bundled demo images served by the GUI's sample affordances: `pass.jpg` (Mill Creek Pilsner — fully compliant) and `fail.jpg` (Mercer's Reserve Vodka — title-case "Government Warning:" prefix). The REVIEW affordance intentionally reuses `pass.jpg` with a Pilsner→Lager mismatch in declared, so no `review.jpg` file is needed. Sample metadata in `src/lib/samples.ts`. | Live demo on the deployed site; reviewer's first interaction. |

## How to pick

- **Writing or fixing a test that needs a real label image** → use a
  file from `test-data-combined/labels/`. Match its `id` against
  `test-data-combined/ground-truth/<id>.json` for declared values.
- **Running `npm run bench`** → defaults to `test-data-combined/`.
- **Running the cross-pair benchmark** → `npm run bench:cross-pair`,
  reads from `test-data-combined/labels/` × {`ground-truth/`,
  `declared-wrong/`}.
- **Demo on the deployed site** → `public/samples/{pass,fail}.jpg`.

## Why `test-data-v2/` exists alongside the superset

Pure path-stability for `benchmarks/routine.ts` and the
`routine-manifest.json` audit trail. The routine subset names 15
specific IDs; pinning them via a static directory means historical
routine runs remain reproducible. Moving the routine manifest into
`test-data-combined/` and deleting `test-data-v2/` is a low-priority
follow-up — see CHANGELOG 2026-05-13 corpus-consolidation note.

## Why `test-data/` (v1) is kept

Historical reference. The v1 images carry the same filenames as the
v2 images but with different image bytes (v2 is a re-render). The
ground-truth files for the two corpora are not interchangeable. For
benchmarks always use `test-data-combined/`.

## What to do if you find a wrong ground-truth

`scripts/cross-validate-ai-corpus.ts` re-runs the corpus through the
vision extractor and flags suspicious GT. If you find a real one,
edit `test-data-combined/ground-truth/<id>.json` AND mirror the
change into `test-data/ai-generated/ground-truth-v2/<id>.json` if
it's an AI label, or `test-data-v2/ground-truth/<id>.json` if it's
an SVG render. The combined directory is the source of truth for
benchmarks; the per-source directories are for provenance.
