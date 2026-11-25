# AI-Generated Label Corpus

An image-generation model created these 50 raster images for LabelVerify tests.

- `labels/`: compressed project copies of the generated label images.
- `ground-truth/`: one JSON metadata file per image.
- `manifest.json`: complete image manifest.
- `validation-audit.json`: machine-readable audit results.
- `validation-report.md`: human-readable audit summary.
- `archived-unmanifested-labels/`: older duplicate filenames retained for traceability, not part of the primary corpus.

Use `expectedFields` as ground truth. `promptDeclaredFields` is preserved only as provenance because AI generation drifted on several producer/address lines.

Validation status:

- 36 images are `strictBenchmarkReady`.
- 14 images are `robustnessOnly`.
- 0 images are rejects.
