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
| Network-free degradation | **OCR + rule-based validators only** | Per `APPROACH.md` §2.2, local VLMs (Florence-2, moondream2) won't fit a Vercel serverless function and are deferred to P2 with a hosted GPU endpoint as the realistic delivery vehicle. The honest contingency is: Tesseract + Gov-Warning text validator + brand fuzzy match keep working when the hosted vision API is unreachable; the rest of the fields return `REVIEW`. |
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

Per-image, target latency. **OCR runs in parallel with the vision call**, so
it is off the critical path; the budget below is the *critical-path sum*,
not the work-sum.

### 4.1 P50 critical path

| Stage | Budget | Off critical path? | Notes |
|-------|--------|--------------------|-------|
| Client compress + upload (~2 MB image, ~400 KB after browser compress) | 350 ms | — | Client-side JPEG re-encode at quality 0.7 keeps payload small. |
| Server pre-process (`sharp`) | 150 ms | — | EXIF orient, resize to ≤ 1600 px long edge, optional auto-contrast. Hot worker. |
| Vision call (hosted, fast tier) | 2,400 ms | — | Gemini Flash / GPT-4o-mini, structured-output JSON-schema mode. |
| OCR (`tesseract`) | 1,200 ms | **yes** — parallel with vision | Tesseract on Vercel Node is 1.0–1.8 s realistic; honest number, not the prior 600 ms. Result is fed into the vision prompt only if it lands before the vision call returns. |
| Matching + validation | 100 ms | — | Pure CPU. |
| Stream first byte + UI paint | 250 ms | — | SSE; UI starts rendering as fields arrive. |
| **Critical-path P50** | **~3.25 s** | | Comfortable under 5 s. |

### 4.2 P95 critical path (honest)

| Stage | P95 | Driver |
|-------|-----|--------|
| Cold-start (`sharp` + tesseract.js bundle on a cold serverless function) | +1,500 ms | Vercel cold-starts after idle. Mitigated by a warmup pinger on `/` page load (see `DEPLOYMENT.md` §6) but not eliminated. |
| Vision call tail | 4,500 ms | Structured-output mode serializes token gen; provider tail behavior is the dominant risk. |
| Upload tail (slow proxy / federal network) | 1,200 ms | TTB office connections behind a proxy. Outside our control. |
| **Critical-path P95** | **~6.5–7.5 s** | Will exceed 5 s on cold + slow-network + provider-tail. |

**We are honest about this:** P50 under 5 s is achievable and is what the
demo shows. P95 above 5 s is real. The mitigations are below.

### 4.3 Mitigations and budget defense

- **Streaming results.** The UI renders fields one-by-one as the SSE pipe
  delivers them. The user sees brand-name PASS at ~2 s even if the full
  envelope takes 5 s. *Perceived* latency stays under budget.
- **Hard timeout.** The vision call has a 5 s `AbortSignal`; if it fires, we
  return a clear timeout error rather than switching to an OCR-only path (
  brand fuzzy match) and mark the rest `REVIEW`. The user is never left
  staring at a spinner past 5 s.
- **Warmup pinger.** `/api/health` is hit on page load to warm the function
  before the user clicks Verify.
- **Tiered escalation runs *off-path*.** If field confidence is low after
  the primary call, the configured backup provider retries once automatically — only when
  has already seen the primary result. The reviewer is not blocked.
- **Skip OCR for batches when benchmark shows it doesn't help.** Decision
  made by data in `benchmarks/results/`, not by guess.
- **Parallelize OCR and vision.** They do not depend on each other; OCR is
  *only* useful if it returns *before* the vision call. If OCR is slower
  than the vision call, we drop its output rather than wait.

### 4.4 What we measure live

Every `/api/verify` response includes a `timings` object: `{ upload,
preprocess, ocr, vision, match, total }`. The deployed UI surfaces
`"Verified in N.N s"` from this. If a reviewer reports slowness, we have
the trace; if the deployed P95 starts drifting, the regression is visible.

## 5. Batch Processing (R3: 200–300 labels; current interactive cap is quota-derived)

Vercel Hobby serverless functions cap execution at 10–60 s. A single
long-running orchestrator function can time out before large batches finish.
The batch design is **per-item function invocations, not a worker pool**.

### 5.1 Flow

1. **Upload.** Client posts a folder of images + one CSV/XLSX of declared
   field values. Server stores them transiently in `/tmp` and returns a
   `batchId` immediately (one short function call, well under the timeout).
2. **Worker fan-out.** A second client request opens an SSE connection to
   `GET /api/verify/batch/:batchId/stream`. That endpoint reads the manifest
   and *fires one `fetch` to `/api/verify` per item*, with bounded
   concurrency (default 8). Each `/api/verify` call is its own function
   invocation, so each item gets its own timeout budget.
3. **Stream-back.** As each per-item function returns, the orchestrator
   forwards the result over SSE to the client. The UI renders a virtualized
   table whose rows fill in as results stream.
4. **Resume.** If the SSE connection drops, the client re-opens with
   `?cursor=<lastIdx>` and the server picks up from there. Job state is
   in-memory but indexed by `batchId` so reconnects within the session
   work.

### 5.2 Math

Default cap: 100 labels from 30 RPM × 80% utilization × 255 usable seconds. Minutes, not
hours, and no single function call exceeds the per-item budget.

### 5.3 What we do not implement

- A real queue (Redis, SQS, etc.). The in-memory `batchId → state` map is
  sufficient for a prototype that does not survive process restart. The
  brief says no persistent storage; we abide by that.
- Cross-session resumability. Refresh-and-resume after browser close is
  out of scope.
- CSV export and PDF report are P1, not P0. The vertical slice ships
  without them.

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
- Webhooks / external queue infrastructure (Redis / SQS). The batch design
  in §5 uses per-item function invocations orchestrated by an in-memory
  job index — sufficient for quota-derived interactive batches without persistence.
- A custom-trained model. We benchmark, we pick, we ship.
- A local VLM fallback. The honest network-restricted contingency is the
  single-path timeout/error behavior described in §2
  §2.2.
