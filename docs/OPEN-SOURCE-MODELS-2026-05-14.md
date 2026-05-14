# Open-source model survey for a hypothetical LabelVerify v2 (2026-05-14)

> Research-only document — not a roadmap commitment. Surveys the open-source ecosystem (HuggingFace + adjacent) for models that could plausibly replace or augment the hosted Gemini 3.1 Flash-Lite pipeline. Generated alongside `RETROSPECTIVE-2026-05-14.md` to answer the question "if a v2 had budget + training infrastructure, which open-source primitives would be the strongest candidates?"
>
> Apex framework — this is §2.3 hypothesis matrix scoping for future work, not implementation.

## Sub-problem 1: Structured-field extraction from labels

Replacing the hosted Gemini single-call JSON extraction.

| Candidate | Size | License | Why it fits | Tradeoff vs Gemini Flash-Lite |
|---|---:|---|---|---|
| [Qwen2.5-VL-7B-Instruct](https://huggingface.co/Qwen/Qwen2.5-VL-7B-Instruct) | 7B | **Apache 2.0** | Native JSON output for bboxes + attributes; documented strong invoice/form extraction. ~95.7 on DocVQA per [technical report](https://arxiv.org/abs/2502.13923). | Comparable doc-VQA accuracy; you handle infra. Single 24 GB GPU (fp16) or 12 GB (int4). ~1–3 s/image on an A10. |
| [InternVL3.5-8B](https://huggingface.co/OpenGVLab/InternVL3_5-8B) | 8B | **Apache 2.0** (code MIT) | Outperforms Qwen2.5-VL on MMStar/MMVet per [InternVL3.5 blog](https://internvl.github.io/blog/2025-08-26-InternVL-3.5/). Multi-field structured extraction with reasoning. | 8B fits on 24 GB consumer GPU. Single A100 comfortable. |
| [Donut](https://huggingface.co/naver-clova-ix/donut-base) | ~200M | MIT | OCR-free seq2seq that emits JSON via special tokens. Tiny enough for CPU inference. | **Zero zero-shot performance on novel layouts; requires labeled training data.** Best after fine-tuning on the existing 170 GT examples. |
| [LayoutLMv3-base](https://huggingface.co/microsoft/layoutlmv3-base) | 125M | CC-BY-NC-SA-4.0 | (Listed only to flag) | **Non-commercial license — exclude from any production candidate list.** |

## Sub-problem 2: OCR for §16.21 exact-match

Replacing or augmenting the Tesseract.js word-bbox layer.

| Candidate | Size | License | Why it fits | Tradeoff |
|---|---:|---|---|---|
| [PaddleOCR-VL](https://huggingface.co/PaddlePaddle/PaddleOCR-VL) | 0.9B | **Apache 2.0** | SOTA on OmniDocBench (92.86). NaViT-style dynamic resolution; designed for pixel-tight text recognition. | Small, single mid-range GPU. Best replacement for Tesseract on this sub-task. |
| [olmOCR-2-7B-1025](https://huggingface.co/allenai/olmOCR-2-7B-1025) | 7B | **Apache 2.0** | Allen AI's GRPO-RL fine-tune of Qwen2.5-VL-7B. olmOCR-Bench 83.1. | Heavier than PaddleOCR-VL but stronger on small print and curved baselines (bottle photos). |
| [GOT-OCR2.0](https://huggingface.co/stepfun-ai/GOT-OCR2_0) | 580M | **Apache 2.0** | OCRBench 61.2, optimized for printed text + structured layouts. CPU-feasible with quantization. | Cheaper than PaddleOCR-VL for the high-contrast printed §16.21 warning specifically. |
| [Surya](https://github.com/datalab-to/surya) | ~300M | GPL-3.0 (commercial license required) | SegFormer + DONUT pipeline; bundles layout detection. | **Exclude from commercial v2 without buying their license** — verify directly on repo. |

## Sub-problem 3: Region / layout detection

Locate the printed-label region on a bottle photo (anchors px↔mm) and the Gov-Warning block. The single largest structural gap in v1.

| Candidate | Size | License | Why it fits | Tradeoff |
|---|---:|---|---|---|
| [DocLayout-YOLO](https://github.com/opendatalab/DocLayout-YOLO) | ~10–30M | AGPL-3.0 (Ultralytics base) | Real-time YOLOv10 fine-tuned for document-region classes. Excellent for the Gov-Warning block after fine-tuning. | **AGPL — commercial use requires Ultralytics license.** |
| [Grounding DINO](https://github.com/IDEA-Research/GroundingDINO) | ~172M | **Apache 2.0** | Open-vocabulary: prompt "government warning text block" / "alcohol label" zero-shot. | Ideal v2 prototype before collecting labeled training data. Single consumer GPU. |
| [OWLv2](https://huggingface.co/google/owlv2-base-patch16-ensemble) | 150–600M | **Apache 2.0** | Prompt-based detection; CLIP-pretrained variants. Faster than Grounding DINO, slightly weaker on long-tail. | Same use case as Grounding DINO; pick one. |
| [SAM 2](https://github.com/facebookresearch/sam2) | various | **Apache 2.0** | Not a detector — once a bbox prompt is provided, extracts the precise (potentially curved) label region from a bottle photo. Pair with Grounding DINO → "Grounded SAM" pipeline. | Free, well-supported. |

## Sub-problem 4: Reference-image template matching

The single capability v1 lacks entirely. Compare a submitted label against the COLA-approved reference label to catch reprints / font swaps / color drift / wrong-artwork shipments.

| Candidate | Size | License | Why it fits | Tradeoff |
|---|---:|---|---|---|
| [DINOv2](https://huggingface.co/facebook/dinov2-large) | 300M | **Apache 2.0** | Self-supervised image embeddings; cosine similarity = exactly the right tool. Robust to lighting, scale. | CPU-feasible for embedding compare; GPU for batch. |
| [SigLIP 2](https://huggingface.co/blog/siglip2) (SO400M variant) | 400M–1B | **Apache 2.0** | Released Feb 2025. Multilingual contrastive encoder; both image + image+text retrieval. | Strongest open option for fidelity matching. |
| [DINOv3](https://arxiv.org/html/2508.10104) | various | **Verify license — weights may be gated under Meta terms** | Aug 2025 release. Stronger dense features than v2. | Confirm commercial-use license before adopting. |

Recommended workflow: hash the COLA reference image with DINOv2 or SigLIP2 → store the embedding → at verify time, embed the cropped submitted-label region and compare by cosine similarity. Threshold-tunable on a small validation set.

## All-in-one open VLMs (replace the hosted Gemini Flash-Lite call entirely)

| Model | Size | License | Note |
|---|---:|---|---|
| [Qwen2.5-VL-7B-Instruct](https://huggingface.co/Qwen/Qwen2.5-VL-7B-Instruct) | 7B | **Apache 2.0** | Best "fits most tasks". DocVQA 95.7. |
| [Qwen2.5-VL-72B-Instruct](https://huggingface.co/Qwen/Qwen2.5-VL-72B-Instruct) | 72B | **Apache 2.0** | Closest open analog to Gemini Flash-Lite quality. Needs ~2× A100 or H100. |
| [InternVL3.5-8B](https://huggingface.co/OpenGVLab/InternVL3_5-8B) | 8B | **Apache 2.0** | Strongest 8B per Aug 2025 benchmarks. |
| [MiniCPM-V-4.5](https://huggingface.co/openbmb/MiniCPM-V-4_5) | 8B | **Apache 2.0** | Compact, mobile-friendly, strong OCR. |
| [Pixtral-12B-2409](https://huggingface.co/mistralai/Pixtral-12B-2409) | 12B + 400M | **Apache 2.0** | DocVQA 90.7; clean weight release from Mistral. |
| [Llama-4-Maverick-17B-128E](https://huggingface.co/meta-llama/Llama-4-Maverick-17B-128E-Instruct) | 17B/400B MoE | Llama 4 Community (custom — commercial OK below 700M MAU; read terms) | Highest ceiling; heaviest infra. |

## Specialized / fine-tuned candidates

**No publicly hosted model fine-tuned specifically for TTB / COLA / §16.21 verification was found on HuggingFace.** This is a real ecosystem gap. Adjacent assets that would help if a fine-tuning campaign were planned:

| Asset | Use |
|---|---|
| [Francesco/wine-labels](https://huggingface.co/datasets/Francesco/wine-labels) | Roboflow-100 wine-label object-detection annotations. Usable for fine-tuning DocLayout-YOLO or Grounding DINO on the "label region" sub-problem. |
| [Roboflow Wine Label Detection](https://universe.roboflow.com/wine-label/wine-label-detection) | Dataset with maker / vintage / ABV / appellation classes. Closer to TTB fields than anything on HF. |
| [Glazkov/qwen2.5-vl-table-extraction](https://huggingface.co/Glazkov/qwen2.5-vl-table-extraction) | Example Qwen2.5-VL fine-tuned for structured JSON extraction. Usable training-recipe blueprint. |

## Top-3 recommendation if a v2 were going to incorporate open-source

If a hypothetical v2 of LabelVerify wanted to replace or augment the hosted Gemini Flash-Lite path with open-source primitives, the strongest three candidates to evaluate first are:

1. **Qwen2.5-VL-7B-Instruct (Apache 2.0)** as the drop-in replacement for the hosted single-call extraction. Best documented open VLM for JSON-structured doc extraction; fits a single 24 GB GPU; straightforward fine-tune path on the existing 170 GT-labeled examples. Expect ~5–10% accuracy degradation vs Flash-Lite on novel layouts before fine-tuning; near-parity or better after.

2. **PaddleOCR-VL-0.9B (Apache 2.0)** as a dedicated, pixel-accurate OCR pass on the Government Warning crop — exactly where exact-match against §16.21 matters, and a small specialist beats a general VLM on both cost and determinism. SOTA on OmniDocBench; tiny enough to run alongside the VLM with no infra growth.

3. **DINOv2 + Grounding DINO (both Apache 2.0)** for the two missing capabilities — reference-template matching and label-region detection respectively. Together these unlock the COLA-approved-reference workflow that v1 has no architectural support for at all, with **no fine-tuning required** for a v0.

Skip Llama-4 (license complexity), Surya (GPL-restricted), and Ultralytics YOLOv8/v10 (AGPL-restricted) unless commercial licenses are purchased.

## What this means for v1 (no change)

This is research, not a roadmap commitment. **Nothing in this document is being adopted into the v1 production architecture.** Incorporating any of these primitives would require:

- Moving away from the Vercel-Hobby-deploy-with-managed-API-keys posture toward a GPU-hosted inference stack (probably one of: AWS Inferentia, GCP T4/L4 instances, Modal, or a dedicated inference cluster).
- A training-data + fine-tuning workstream (~$500–$5K + 1–2 days per published Gemini Flash SFT case studies).
- Validation against the existing 170-image bench under the wave-28a stratified guardrail.

Decision deferred to a future v2.

## Sources

- [Qwen2.5-VL Technical Report (arXiv 2502.13923)](https://arxiv.org/abs/2502.13923)
- [InternVL3.5 blog (Aug 2025)](https://internvl.github.io/blog/2025-08-26-InternVL-3.5/)
- [HuggingFace VLMs 2025 overview](https://huggingface.co/blog/vlms-2025)
- [olmOCR-2 model card](https://huggingface.co/allenai/olmOCR-2-7B-1025)
- [PaddleOCR-VL model card](https://huggingface.co/PaddlePaddle/PaddleOCR-VL)
- [Pixtral 12B paper (arXiv 2410.07073)](https://arxiv.org/abs/2410.07073)
- [SigLIP 2 blog](https://huggingface.co/blog/siglip2)
- [DocLayout-YOLO repo](https://github.com/opendatalab/DocLayout-YOLO)
- [SAM 2 repo](https://github.com/facebookresearch/sam2)
- [Grounding DINO repo](https://github.com/IDEA-Research/GroundingDINO)
