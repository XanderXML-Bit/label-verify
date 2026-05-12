# AI-Generated Label Corpus

This folder contains 50 AI-generated raster images created with the Codex built-in image generation tool for LabelVerify robustness testing.

- `labels/`: compressed project copies of the generated label images.
- `ground-truth/`: one JSON metadata file per image.
- `manifest.json`: complete image manifest.

Important: these images are intended to complement the deterministic SVG/code corpus. Because AI image generation can distort small text, the prompt-declared fields are not strict benchmark ground truth until each image's `visualAudit` record is accepted and any text drift is transcribed.
