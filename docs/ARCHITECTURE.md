# Architecture

> Companion to [evaluation-brief.md](evaluation-brief.md). Every decision here
> cites the requirement (Rn) it serves.

## 1. System at a Glance

```
┌──────────────┐     ┌────────────────────────────────────────────┐     ┌──────────┐
│  Browser UI  │ ──▶ │            Verification API                │ ──▶ │ Results  │
│ (Next.js)    │     │  ┌──────────┐  ┌──────────┐  ┌──────────┐  │     │  Cache   │
│ Drag/drop +  │     │  │ Pre-proc │─▶│ Extract  │─▶│  Match   │  │     │ (in-mem) │
│ batch grid   │     │  │ (sharp)  │  │ (vision  │  │  (fuzzy  │  │     └──────────┘
└──────────────┘     │  └──────────┘  │  + OCR)  │  │ + strict)│  │
                     │                └──────────┘  └──────────┘  │
                     └────────────────────────────────────────────┘
```

Single Next.js app: React UI + API routes in one deploy. No separate backend
service. Justification: minimizes cold-start latency (R1), simplifies
deployment (R8), keeps the prototype legible to reviewers (eval criteria #2).

## 2. Tech Stack

| Layer | Choice | Why |
|-------|--------|-----|
| Framework | **Next.js 15 (App Router)** | One artifact for UI + API, first-class Vercel deploy, streaming responses help perceived latency (R1, R8). |
| Language | **TypeScript (strict)** | Catch contract drift between extractor outputs and validators. Same stack as Splitful — proven reuse. |
| UI primitives | **Tailwind + shadcn/ui** | Accessible defaults out of the box (R2). No bespoke design system needed for a prototype. |
| Image preprocessing | **sharp** | Native, fast resize/normalize/orient before any model call. Trims payload sent to vision API. |
| OCR (local) | **tesseract.js** (browser) and **tesseract** binary (server) | Zero-network fallback (R4 robustness, network-blocked TTB risk). |
| Hosted vision | **OpenAI Vision** via direct API or **OpenRouter** | Same access pattern Splitful uses; OpenRouter lets us A/B GPT-4o, Claude Sonnet, Gemini Flash without rewriting. |
| Local vision (fallback) | **Florence-2** or **moondream2** via Transformers.js / ONNX | Runs without third-party network — important per `evaluation-brief.md` §10. |
| Fuzzy matching | **fast-fuzzy** or hand-rolled normalized Levenshtein | Tiny dep; brand normalization is straightforward (R6). |
| Validation | Hand-rolled rules + zod schemas | Government Warning rule is too strict and too specific to outsource (R5). |
| Tests | **vitest** | Same as Splitful; ESM-friendly, fast. |
| Benchmarks | Custom harness in `benchmarks/` | See `TEST-STRATEGY.md`. |
| Deploy | **Vercel** + custom domain (`labelverify.zendren.net` candidate) | Free, fast, edge-friendly, public URL satisfies R8. |

## 3. Verification Pipeline

For one label image:

1. **Receive** — multipart upload, URL fetch, or PDF page extraction.
2. **Pre-process** — `sharp` normalizes orientation (EXIF), resizes to a long
   edge ≤ 1600 px, enhances contrast if histogram suggests low light.
3. **Extract (parallel)** — two extractors run in parallel:
   - **OCR pass**: tesseract for raw text + bounding boxes.
   - **Vision pass**: one structured-output call to the chosen vision model,
     **with the OCR text included in the prompt**. This is the key
     performance unlock: the model doesn't have to re-read every character;
     it cross-references OCR output and the image, which is faster and more
     accurate than either alone. (See `APPROACH.md` for the experimental
     justification.)
4. **Match** — field-by-field comparison against the declared application:
   - Strict equality for Government Warning, country of origin, class/type.
   - Tolerant numeric comparison for ABV / net contents (with unit
     conversion).
   - Fuzzy normalized comparison for brand name and address.
5. **Bold/caps detection for Gov Warning** — the strict rule (R5) requires
   not just textual match but visual properties. Strategy:
   - Crop the bounding box that contains "GOVERNMENT WARNING:" from the OCR
     pass.
   - Run a small classifier (stroke-width / pixel-density heuristic) to
     confirm the prefix is bold.
   - Confirm all-caps via the OCR text itself.
6. **Aggregate** — per-field `{ pass, expected, actual, confidence,
   evidence }` objects → final verdict + reasons.
7. **Stream** — results are streamed back so the UI can render fields
   one-by-one rather than waiting for the full envelope.

## 4. Latency Budget (R1: ≤ 5s end-to-end)

Per-image, target P50:

| Stage | Budget | Notes |
|-------|--------|-------|
| Network upload (1 image, ~2MB) | 400 ms | Compress client-side before send. |
| Pre-process (sharp) | 150 ms | Server-side, hot worker. |
| OCR (tesseract) | 600 ms | Parallel with vision call. |
| Vision call (hosted) | 2,500 ms | The big one. We pin to fastest tier (Gemini Flash / GPT-4o-mini) by default; upgrade only on low confidence. |
| Matching + validation | 100 ms | Pure CPU. |
| Stream + render | 250 ms | First-byte streaming. |
| **Total P50** | **~4.0 s** | Headroom for P95. |

Strategies to stay under budget:

- **Parallelize** OCR and vision (they don't depend on each other).
- **Stream** partial results — user sees brand name before warning check finishes.
- **Tiered model selection** — start with a fast model, only escalate if
  confidence < threshold on critical fields.
- **Skip OCR for batches** if vision-only is good enough (decided by
  benchmark, not by guess).

## 5. Batch Processing (R3: 200–300 labels)

- Upload triggers a job; the API returns a job ID immediately.
- Server processes in a bounded concurrency pool (default 8 workers).
- UI polls or subscribes via Server-Sent Events for per-item status.
- Results table is virtualized (R2: must stay usable at 300 rows).
- CSV export of full results table.

300 labels × 4s with 8 concurrent workers = ~150s total. That's the right
order of magnitude — minutes, not hours.

## 6. Imperfect-Image Tolerance (R4)

Layered defense:

1. **Pre-processing** (sharp): EXIF auto-orient, auto-contrast, optional
   deskew.
2. **Vision model** is inherently tolerant — that's its whole job.
3. **OCR + vision cross-check**: when OCR confidence is low, we trust the
   vision model more, and vice-versa. Documented as the "consensus" path in
   `APPROACH.md`.
4. **Confidence floor**: any field below threshold is flagged for human
   review rather than auto-passed/failed. The UI surfaces this as a yellow
   state, not red or green. This is honest about model uncertainty — which
   is itself a quality signal to the evaluator.

## 7. Security / Safety (Prototype-Appropriate)

- No user data persisted to disk; in-memory only, cleared on session end.
- Rate limit on the upload endpoint to keep the public demo from being
  abused.
- API keys server-side only; never exposed to the browser.
- No PII processed — labels are public artwork.

## 8. Things We Are Deliberately Not Building

- User accounts / SSO.
- A database. Sessions live in memory; the prototype is stateless.
- Webhooks / queue infrastructure. A simple worker pool is enough for 300
  labels.
- A custom-trained model. We benchmark, we pick, we ship.
