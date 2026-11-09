# Test PDF rendering

These fixtures contain synthetic labels, not applicant or Treasury records.

- `standard-fonts.pdf` preserves the original task reproducer. It contains Helvetica Bold, Times Roman, Courier, and vector paths.
- `embedded-font.pdf` contains a subset-embedded DejaVu Sans font and a colored rectangle.
- `scanned-image.pdf` contains one RGB image. It has no text layer.

The last two fixtures use ReportLab 5.1.0 and Pillow. Their text reads `EMBEDDED LABEL 42` and `SCANNED LABEL 42`.
The embedded font uses the license in `DejaVu-LICENSE.txt`.

Run the unit regression tests:

```sh
npx vitest run src/tests/pdf.test.ts
```

The pixel checks inspect the top 40% of each page. That region contains text and excludes the colored blocks.
They reject a blank raster, missing standard-font glyphs, and incompatible native canvas objects.

Run the packaged production routes:

```sh
npm run build
node scripts/test-pdf-production.mjs
```

The smoke script starts localhost-only standalone servers with all four provider keys forced to empty strings.
Empty values prevent Next.js from restoring keys through packaged dotenv files.
Offline mode must return `503 offline-demo` before parsing uploads.
Live mode must render each PDF before reaching the missing-provider-key guard.
The expected downstream responses are `502` for extraction and `500` for verification.
Those responses prove the PDF path works, not that model verification succeeds.
No provider request, paid call, production upload, or deployment occurs.

You can pass a standalone directory as the script's first argument.
Use a copy outside the repository to test traced assets without parent dependency fallback.
