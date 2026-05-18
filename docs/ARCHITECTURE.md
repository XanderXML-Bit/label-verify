# Architecture

Reference for the verification pipeline that backs [the live demo](https://label-verify-six.vercel.app). Companion documents: [`MODEL-SELECTION.md`](MODEL-SELECTION.md) for the model bake-off, [`FAILURE-MODES.md`](FAILURE-MODES.md) for the failure taxonomy, [`CLI.md`](CLI.md) for the three command-line surfaces.

## 1. System overview

Single Next.js 15 application: React UI (`src/app/`), API routes (`src/app/api/`), and pipeline modules (`src/lib/`) ship in one deployment to Vercel. Justification: minimises cold-start latency, simplifies the deployment surface, and keeps every code path reviewable in one repo.

```
┌──────────────┐     ┌────────────────────────────────────────────┐     ┌────────────────────┐
│  Browser UI  │ ──▶ │            Verification API                │ ──▶ │ JSON / CSV exports │
│  (Next.js)   │     │  ┌────────┐  ┌──────────┐  ┌────────────┐  │     │ + review queue     │
│  Drag/drop, │     │  │ Sharp   │─▶│ Vision    │─▶│ Per-field  │  │     │ (in-memory)        │
│  batch grid  │     │  │ preproc │  │ extractor │  │ comparators│  │     └────────────────────┘
└──────────────┘     │  └────────┘  └──────────┘  └────────────┘  │
                     │                                            │
                     │  ┌──────────┐  ┌───────────────────────┐   │
                     │  │ Tesseract │  │ Government-Warning    │   │
                     │  │ OCR (bbox)│─▶│ validator (4 subscores)│  │
                     │  └──────────┘  └───────────────────────┘   │
                     └────────────────────────────────────────────┘
```

The UI is the public surface. The three CLIs (`bin/labelverify.ts`, `bin/labelverify-web.ts`, `bin/labelverify-bench.ts`) are operator/reviewer tools that exercise the same pipeline in different ways — see [`CLI.md`](CLI.md).

## 2. Stack

| Layer | Choice | Rationale |
|---|---|---|
| Framework | **Next.js 15** (App Router) | One artifact for UI + API; first-class Vercel deploy; streaming-response semantics for the batch route. |
| Language | **TypeScript strict** | Catches contract drift between extractor output and downstream validators at compile time. |
| UI primitives | **Tailwind 3** + lightweight bespoke components | Accessible defaults; no design-system dependency. |
| Image preprocessing | **sharp** (libvips) | EXIF auto-orient, Lanczos-3 resize to **2000 px long edge** (wave-31j upscales sub-target images), JPEG 82 with mozjpeg. Trims oversize payloads while giving the VLM enough resolution to discriminate subtle bold/size perturbations. |
| Vision extractor (primary) | **Gemini 3.1 Flash Lite** via `@google/generative-ai` | Pareto-dominant on the bake-off (accuracy × latency × cost). See [`MODEL-SELECTION.md`](MODEL-SELECTION.md) §4. |
| Vision extractor (second-opinion) | **Gemini 2.5 Flash** via `@google/generative-ai` | Smarter same-provider second-opinion fires on borderline-Gov-Warning REVIEW. Wave 22 swap (2026-05-13) — see [`WAVE-22-FINDINGS.md`](WAVE-22-FINDINGS.md). |
| Vision extractor (cross-provider fallback) | **GPT-5.4-nano** via `openai` | Provider-diversity safety net on primary provider failure (5xx / timeout / abort). Distinct from the second-opinion above. |
| OCR | **tesseract.js 5** | Server-side only. Used for the Government-Warning prefix bbox + pixel-density measurements; not used for text reading (the vision extractor returns the text directly). |
| Field matching | Hand-written comparators in `src/lib/matching/` | Per-field semantics (ABV tolerance, brand fuzziness, multilingual country, US-state-implies-domestic) are easier to audit as discrete functions than as a single fuzzy-matcher. |
| Government-Warning validation | `src/lib/validation/` | Four subscores: text exact match (string predicate), all-caps prefix (string predicate), bold prefix (classical CV stroke-width transform on OCR-anchored pixels), size threshold (bbox dimensions vs declared net contents). |
| Schemas | **Zod** | All inbound JSON validated at the route boundary. Same schemas reused by the CLI. |
| Tests | **Vitest** (unit/integration) + **Playwright** (E2E) | Vitest for the 942 in-process tests across 89 files, Playwright for the 8 GUI E2E specs. |
| Benchmarks | Custom harness in `benchmarks/` and `bin/labelverify-bench.ts` | The bake-off (`bench:bakeoff`) and the cross-pair benchmark (`bench:cross-pair`). |
| Deploy | **Vercel** (Hobby plan) | Free, public URL, post-deploy smoke workflow validates `/api/health` on every push to `main`. |

## 3. Single-image verification pipeline

For one POST to `/api/verify`:

1. **Receive**. Multipart upload (`image` + `declared` JSON) or JSON body (`{ url, declared }`). The route validates MIME (image: JPEG / PNG / WebP / HEIC / HEIF / PDF), size (≤ 10 MB image, ≤ 25 MB PDF), and the `declared` payload against `DeclaredFieldsSchema`. Per-IP rate limit applies.
2. **Preprocess** (`src/lib/preprocess.ts`). `sharp` performs EXIF auto-orient, then Lanczos-3 resize to a 2000-px long edge (wave-31j; aspect ratio preserved). Sub-target images are upscaled (the wave-28b default `withoutEnlargement: true` kept 1024×1536-class corpora at native size, which silently under-resolved subtle bold/size perturbations — see `WAVE-31j-UPSCALE-2000-SHIPPABLE.md`). The pipeline re-encodes JPEG at quality 82 with mozjpeg. PDFs render the first page via `pdfjs-dist` + `@napi-rs/canvas` before entering this step. Env overrides `LV_MAX_EDGE` and `LV_ENLARGE=0` are retained for research/benching.
3. **Extract and OCR in parallel** (`src/lib/verify.ts:verifyLabel`).
   - The vision extractor (`src/lib/vision/gemini.ts`) issues a single structured-output JSON-schema call to Gemini 3.1 Flash Lite. The prompt requests all seven declared fields plus the Government-Warning block (`raw_text`, `prefix_text`, `prefix_bbox`, `prefix_appears_bold`, `prefix_appears_caps`).
   - Concurrently, `tesseract.js` produces word-level bounding boxes and confidences. The OCR text is not passed into the vision prompt; OCR exists for the Government-Warning bold/size measurements only.
   - Both calls share an `AbortController` bounded by the per-mode vision timeout. The Government-Warning validator awaits OCR up to an 8-second cap before falling back to model-self-reported bold/caps flags.
4. **Match fields** (`src/lib/matching/`). Seven independent comparators run in parallel (`Promise.all`). Each returns `{ status: pass | fail | review, expected, actual, confidence, reason? }`. Notable semantics:
   - `brand`: Levenshtein + token-set similarity. Thresholds in `brand.ts`.
   - `abv`: percentage-point tolerance differentiated by `class_category` (TTB rules differ for beer / wine / spirits). See `abv.ts`.
   - `net_contents`: value + unit comparison with `max(1.5 ml, 0.5 %)` tolerance after unit conversion.
   - `producer`: address-component comparison; US state inference is gated on a strict 2-letter state code **and** at least one corroborating component (so a hallucinated state cannot single-handedly pass an obviously non-domestic claim).
   - `country_of_origin`: synonym map across 7 languages and 25 countries.
   - `class_type`: alias table with separate `SAFE_ALIASES` (auto-PASS) and `REVIEW_ALIASES` (route to REVIEW) tiers.
   - `government_warning`: see step 5.
5. **Validate Government Warning** (`src/lib/validation/government-warning-validator.ts`). Four subscores aggregate via worst-of:
   - **Text** — `normalizeForTextMatch(extracted.raw_text)` strictly equals the canonical §16.21 statement. The normalizer folds NBSP, narrow NBSP, en-quad through hair-space, medium math space, ideographic space, zero-width space, BOM, smart quotes, em-dashes, and ellipsis to ASCII equivalents before comparison.
   - **Caps** — `isPrefixAllCaps(prefix_text)` after small-caps Unicode folding.
   - **Bold** — `measureRelativeBold` runs a classical-CV stroke-width transform on the OCR-bbox-anchored pixels (greyscale → threshold-binarise at 128 → per-column mean dark-run-length, normalised by bbox height) and compares prefix stroke to body stroke. Falls back to the model's `prefix_appears_bold` flag at advisory 0.6 confidence when OCR cannot locate the prefix.
   - **Size** — bbox height converted to mm via declared net contents, compared to §16.22 minima (1 mm small containers / 2 mm large).
6. **Aggregate verdict** (in `src/lib/verify.ts` — the `aggregateVerdict` helper). Worst-of across all field statuses plus the Government-Warning status. A single FAIL on any regulated field produces a FAIL verdict.
7. **Image quality** (`src/lib/verify.ts`). Independent of the verdict. Derived from per-field extractor confidence on fields the model actually read (`value !== null`). `bad` = mean < 0.6 and min < 0.3; `low` = mean < 0.6; otherwise `good`. When image quality is `bad` and the worst-of rule would have returned FAIL, the orchestrator routes to REVIEW with a re-photograph reason — a corrupt photo of a compliant label is not non-compliance.
8. **Confidence-based deferral**. If every field PASSED but any field's extractor confidence is below `REVIEW_CONFIDENCE_THRESHOLD = 0.55`, downgrade PASS → REVIEW with a citation-grade reason identifying the borderline field.
9. **No-OCR Government-Warning gate**. If OCR failed or timed out AND the Government-Warning status is PASS at confidence below 0.55, route to REVIEW. The bold and size subscores fell back to model-self-reported flags without a pixel-tight measurement; a human is the right adjudicator.
10. **Independent second opinion**. When the verdict lands on REVIEW because of the Government-Warning (steps 8 or 9), the orchestrator fires a single vision call against the second-opinion model (default `gemini-2.5-flash` since wave 22, configurable via `SECOND_OPINION_PROVIDER` / `SECOND_OPINION_MODEL`), re-validates the warning from that extractor's read, and attaches `secondOpinion: { modelId, governmentWarning, agreesWithPrimary, reason, latencyMs }` to the response. The UI surfaces agreement (🔁) or disagreement (⚖) inline. Fires on ~5–15 % of verifications. The OpenAI `MODEL_FALLBACK` is a separate concern (provider-diversity safety net when the primary itself fails); see §6 env-var table.
11. **Return**. JSON response includes the verdict, per-field statuses, the Government-Warning block, the extracted-fields block, timings (`preprocess`, `ocr`, `vision`, `matching`, `total`), `imageQuality`, `modelId`, `modelVersion`, `modeUsed`, `requiresHumanReview`, and `reviewReasons[]`. `X-Request-Id` header echoes the client's request id when provided.

## 4. Latency budget

End-to-end target: ≤ 5 s. Warm-function, single-image measurements:

| Stage | P50 | P95 | Notes |
|---|---:|---:|---|
| Preprocess (`sharp`) | ~120 ms | ~180 ms | EXIF orient, resize, JPEG re-encode. |
| Vision call (Gemini 3.1 Flash Lite) | ~2 000 ms | ~3 500 ms | Provider-bound; dominant cost. |
| OCR (`tesseract.js`, parallel with vision) | ~800 ms | up to 8 000 ms cap | Off the critical path unless OCR is bound to the GW validator's 8-s race. |
| Field matchers + GW validator | < 50 ms | < 100 ms | Pure CPU. |
| Independent second opinion (~5–15 % of calls) | + ~2 500 ms | + ~7 000 ms | Fires only on borderline GW outcomes. Gemini 2.5 Flash (wave 22) is ~2× the per-call latency of the previous gpt-5.4-nano second-opinion. |
| **Server total (happy path)** | **~3.0 s** | **~4.1 s** | Server-side `result.timings.total`; second-opinion path adds ~2.5 s on the ~5–10 % of calls that fire it. |
| **Client-perceived end-to-end** (wave-35c Playwright measurement) | **~4.9–5.0 s warm** | **~7–8 s cold** | What the user actually waits. Adds client-side JPEG compression, network round-trip, JSON parse, and React render on top of the server total. Cold-start tax (Vercel function spin-up + first Gemini connection handshake) is the dominant adder on the first verify after page load. The result panel surfaces both numbers — `Verified in 5.0 s (server 4.5 s)` — so the gap is always visible. |

Cold start adds ~500–1 500 ms on the first request after idle. The `/api/warmup` route pre-warms `sharp`, the Tesseract worker, and the Gemini SDK; it is fired on page load.

Mitigations the orchestrator applies:
- Vision and OCR race in parallel.
- The vision call has an `AbortSignal` bounded by the per-mode timeout; OCR has a separate 8-s race cap inside the GW validator.
- The `OpenAI` module is dynamically imported and memoized at module scope so the fallback path does not pay an import cost per call.
- The `parseApplication` cache in the batch route is keyed by `File` reference via `WeakMap`, so per-batch parses are reused across the broadcast / per-pair loops without leaking `@ts-expect-error` mutations.

## 5. Batch processing

`/api/verify/batch` handles ≥ 2 images plus optional application files. The route's pairing pipeline runs four stages in cost order before any per-pair vision call fires (full details in `src/app/api/verify/batch/route.ts`):

1. **Inline-manifest detection** — when a single CSV or JSON with multiple rows is dropped alongside images and the file has a `filename` / `file` / `image` / `label` / `cola_number` / `id` column, every row expands into a per-image pair.
2. **Filename stem matching** — case-insensitive, face-tag-aware (`123-front.jpg` ↔ `123-back.jpg` ↔ `123.pdf`), app-tag-aware (`123-front.jpg` ↔ `123-app.pdf`).
3. **Content-based fallback** — for anything still unpaired, the route parses each unpaired application file's brand + class + ABV and runs a lightweight vision extraction on each unpaired image; greedy-matches by weighted similarity (brand 0.65, class 0.25, ABV 0.10) with a 0.55 threshold.
4. **Single-application broadcast** — when ≥ 2 unpaired images remain alongside exactly 1 unpaired single-product application file, the parsed fields broadcast to every image with a warning surfaced for operator review.

Per-pair verification runs inline in the POST handler with `INLINE_BATCH_CONCURRENCY = 12` by default (wave-15b; env-overridable, clamped to the batch size). The response includes pairing metadata (`pairing.mode`, `pairing.pairs[]`, `pairing.unpairedImages[]`, `pairing.unpairedApplications[]`), per-row results, an aggregate summary, and the effective `concurrency` value so the UI's progress bar can label "Verifying N images (M in parallel)" against the server-reported truth. The Vercel Hobby plan caps function duration at 60 s, which sets the practical interactive batch ceiling (~100 images per submit at the measured per-call latency).

An SSE batch endpoint (`/api/verify/batch/[id]/stream`) exists for local-dev use where the in-process batch-store is shared across the POST and GET function invocations. In production (Vercel serverless), the POST handler returns terminal results inline and the UI's `BatchView` skips the SSE entirely — this avoids the instance-isolation race that would otherwise 404 the GET hop.

## 6. Configuration

Runtime environment variables (see `.env.example`):

| Variable | Required | Purpose |
|---|---|---|
| `GOOGLE_API_KEY` | yes | Primary vision (Gemini 3.1 Flash Lite) + default second-opinion (Gemini 2.5 Flash). |
| `OPENAI_API_KEY` | recommended | Cross-provider primary-failure fallback (GPT-5.4-nano). When primary Gemini fails entirely (5xx / timeout / abort), the orchestrator retries on OpenAI. Without it, Gemini failures surface as 5xx responses. NOT the second-opinion path. |
| `OPENROUTER_API_KEY` | optional | Bake-off harness only; not used at runtime. |
| `ANTHROPIC_API_KEY` | optional | Bake-off harness for the Claude tier. |
| `MODEL_PRIMARY` | optional | Overrides the default `gemini-3.1-flash-lite` primary extractor. Operations escape hatch for A/B testing a new Google model without a code change. |
| `MODEL_FALLBACK` | optional | OpenAI model id used for the primary-failure fallback. Defaults to `gpt-5.4-nano`. |
| `SECOND_OPINION_PROVIDER` | optional | `gemini` (default) or `openai`. Routes the REVIEW-trigger recheck. Wave 22. |
| `SECOND_OPINION_MODEL` | optional | Model id for the chosen second-opinion provider. Defaults: `gemini-2.5-flash` (gemini), `gpt-5.4-nano` (openai). |
| `RATE_LIMIT_PER_MIN` | optional | Per-IP rate limit on `/api/verify`, `/api/extract`, `/api/application/parse`. Defaults to 60. |
| `RATE_LIMIT_BATCH_PER_MIN` | optional | Per-IP rate limit on `/api/verify/batch`. Defaults to 3. |
| `GEMINI_RPM_LIMIT` | optional | Project-level Gemini RPM. The interactive batch capacity derives from this. Defaults to 30. |
| `DEBUG_TOKEN` | optional | Bearer-gated access to `/api/debug/last` and the review-queue resolve endpoint. Timing-safe compare via `crypto.timingSafeEqual`. |

## 7. Security

Full threat model: [`../SECURITY.md`](../SECURITY.md). High-level posture:

- Strict MIME allow-list at every upload endpoint.
- 256 MiB aggregate cap on batch requests; 10 MB per image; 25 MB per PDF.
- Per-IP rate limits on the single-image, batch, and application-parse endpoints.
- SSRF guard on URL fetch (rejects RFC1918 + loopback + link-local + CGNAT + non-canonical IPv4 literals; manual redirect-following with re-validation).
- CSV formula-injection mitigation on every export endpoint (cells beginning with `=`/`+`/`-`/`@`/tab/CR are prefixed with `'` per OWASP).
- Security headers in `vercel.json`: HSTS preload, X-Content-Type-Options, X-Frame-Options DENY, Referrer-Policy, Permissions-Policy deny-all, Content-Security-Policy.
- No persistent storage. Review queue and batch store are in-process.
- The `/api/debug/last` ring buffer is gated by `DEBUG_TOKEN` (Bearer header, timing-safe compare).

## 8. Out of scope

The following are deliberate non-features for the prototype:

- User accounts, SSO, persistent storage. Brief §9 waives persistence.
- A custom-trained model. The bake-off picks a hosted vision model.
- A local VLM fallback for offline operation. The configured fallback is a different hosted provider; a local-VLM contingency is documented in [`REMAINING-IMPROVEMENTS.md`](REMAINING-IMPROVEMENTS.md).
- Cross-session batch resume. The in-memory batch store is sufficient for the prototype's interactive use; a production deployment would add Postgres + Redis.
