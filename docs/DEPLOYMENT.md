# Deployment

> The reviewer must be able to click a link and use the prototype. This
> document is the operational plan to make that link reliable.
>
> **For the click-by-click runbook**, see
> [`DEPLOYMENT-CHECKLIST.md`](./DEPLOYMENT-CHECKLIST.md) — every Vercel
> action spelled out. **For the six-check smoke after deploy**, see
> [`PRODUCTION-SMOKE.md`](./PRODUCTION-SMOKE.md). This file
> (`DEPLOYMENT.md`) covers the architectural rationale: region choice,
> function-memory budget, fallback behavior. Together they form the
> deployment guide.

## 1. Target

- **Host:** Vercel (free tier, Hobby plan is sufficient).
- **URL:** the default `*.vercel.app` URL (production deploy is
  `https://label-verify-six.vercel.app`). No custom domain is wired —
  the prototype ships on the Vercel hostname and that's the URL in
  the README + GitHub repo. A custom domain would add no reviewer
  value and would add maintenance burden post-submission.
- **Region:** `iad1` (us-east-1, same coast as Treasury / DC reviewers — minimizes RTT).

### 1.1 Provision-Today Checklist

The provisioning happens *before* the first extractor is written, so
the URL is live and warm by the time the demo exists. From the
archived `docs/archive/TODO.md` Phase 1:

- [x] Create Vercel project linked to the GitHub repo
- [x] First push triggers a deploy; the placeholder home page should
      respond within minutes
- [x] Smoke-test from a clean browser
- [x] Record the `*.vercel.app` URL in the submission

## 2. Why Vercel

- Next.js is first-class on Vercel — zero-config builds.
- Free tier covers the prototype's traffic.
- Edge functions option available if we want to push the API closer to the
  user (we likely won't — vision API calls dominate latency anyway).
- Public URL with HTTPS out of the box (R8).
- The prototype ships on the default `*.vercel.app` URL. No custom
  domain is wired; the brief doesn't require one and a half-built
  one is worse than none.

## 3. Environment Variables

Stored in Vercel project settings (never in the repo). `.env.example`
is the canonical source — this table mirrors it. README + DEPLOYMENT-
CHECKLIST cover acquisition.

| Var | Required? | Purpose |
|-----|-----------|---------|
| `GOOGLE_API_KEY` | **Yes** | Primary vision tier (Gemini 3.1 Flash Lite). |
| `OPENAI_API_KEY` | Recommended | Auto-fallback (GPT-5.4-nano) when Gemini fails. |
| `OPENROUTER_API_KEY` | Optional | Used only by the bake-off harness (not the deployed verify path). |
| `MODEL_PRIMARY` | Optional | Override the primary model id. Default: `gemini-3.1-flash-lite`. |
| `MODEL_FALLBACK` | Optional | Override the fallback model id. Default: `gpt-5.4-nano`. |
| `VISION_TIMEOUT_MS` | Optional | Wall-clock budget for the vision call. Default: `60000`. |
| `MAX_BATCH_SIZE` | Optional | Hard cap on uploads per batch request. Default: `1000`. |
| `RATE_LIMIT_PER_MIN` | Optional | Per-IP per-endpoint cap on the public demo. Default: `60`. |
| `DEBUG_TOKEN` | Optional | Bearer token gating `/api/debug/last`, `/api/queue`, and the detailed `/api/health` payload. Leave unset to hide those surfaces entirely. |

A `.env.example` documents every var. The README explains how to obtain
each key.

## 4. Build & Deploy Pipeline

- **`main` branch** auto-deploys to production.
- Every PR gets a preview deploy with its own URL — useful for the reviewer
  if they want to see iterative progress.
- Pre-deploy checks (in `package.json`):
  - `npm run typecheck`
  - `npm run lint`
  - `npm run test`
  - `npm run bench:smoke` (20-image subset; fails build on accuracy
    regression > 5pp)

## 5. Domain Setup

The prototype ships on its auto-generated Vercel hostname
(`https://label-verify-six.vercel.app`) — **no custom domain is wired**.
The planned `labelverify.zendren.net` CNAME was dropped on 2026-05-12
because a custom domain adds no reviewer value and would add
maintenance burden post-submission (see CHANGELOG).

If you fork the project and want a custom hostname, the standard
Vercel flow is:

1. Add `<your-subdomain>` CNAME → `cname.vercel-dns.com` on your DNS
   provider.
2. Add the domain in Vercel project → Domains.
3. Wait for SSL cert issuance (~minutes).

## 6. Cold-Start & Latency Considerations

- Next.js API routes on Vercel are serverless functions. First request after
  idle has a cold start (~500–1500 ms for Node, more if `sharp` /
  `tesseract.js` are first-loaded on the same call).
- Mitigation: a tiny **warmup pinger** on the deployed home page that hits
  `/api/health` and `/api/warmup-tesseract` on load. Keeps the function and
  the OCR engine warm during a demo session.
- `sharp` and `tesseract.js` are declared in
  [`next.config.js`](../next.config.js) under `serverExternalPackages` so
  Next's bundler does not try to inline their native / WASM payloads.
- Hard 5 s `AbortSignal` on every vision call (see `ARCHITECTURE.md` §4.3).
  If the call exceeds budget, we fall back to OCR-only validation instead of
  blocking the user; the UI surfaces this as a `REVIEW` outcome with a
  "Run again with stronger model" CTA.

## 7. Observability

Bare minimum for a prototype:

- Vercel built-in request logs.
- `/api/health` returns `{ ok: true, model: MODEL_PRIMARY, version: SHA }`.
- **`GET /api/debug/last`** — reviewer introspection for the most recent
  verification(s).
  - **Auth.** Gated by the `DEBUG_TOKEN` env var. Callers send
    `Authorization: Bearer <DEBUG_TOKEN>`. When `DEBUG_TOKEN` is unset, the
    endpoint returns `404 Not Found` (not `401`) so that a deployment that
    has not opted into debug mode is indistinguishable from one where the
    route does not exist. A wrong bearer returns `401`.
  - **Query.** `?id=<traceId>` returns one trace; no `id` returns the most
    recent 20, newest first.
  - **Payload.** Each trace contains the declared inputs, preprocessed
    image dimensions, model id + version + prompt hash, raw OCR text
    (redacted to the first 1000 chars), the raw extractor output, and the
    `VerifyResponse` the user saw. The bearer token itself is never
    logged.
  - **In-memory caveat.** The store is a module-scope ring buffer (cap 20)
    that wipes on every cold start and is not shared between serverless
    instances. This is an explicit prototype tradeoff — a hosted version
    would persist to a short-TTL KV (Upstash / Vercel KV). The cap keeps
    the worst-case memory footprint trivially bounded.

## 7a. Vercel plan deltas (Hobby → Pro)

The deployed demo runs on **Hobby**, which is sufficient for a
take-home review. A TTB-deployed fork would want **Pro** for two
reasons relevant to this app:

| Limit | Hobby (current) | Pro | Why it matters here |
|---|---|---|---|
| Function timeout | 30 s | up to 300 s | Cold-start + a Smart-tier (Gemini 3.1 Pro Preview) verify call can flirt with 30 s. Pro removes the worry. |
| Function memory | 2 GB | up to 3 GB (per-function override) | The vision call is small; the ceiling matters only if we ever introduce a local VLM. Headroom for `sharp` + `tesseract.js-core` is already comfortable at 2 GB. |
| Concurrency | best-effort | provisioned concurrency available | Reduces cold starts during a batch upload of 1,000 labels. |
| Bandwidth | 100 GB / mo | 1 TB / mo | Batch CSV / image traffic could plausibly exceed Hobby for a real ops team. |
| Team seats | 1 | configurable | TTB review teams will want > 1 maintainer. |
| Analytics | n/a | included | Useful for monitoring real-user verify latency. |
| Log retention | 1 hour | up to 30 days | `X-Request-Id` tickets are only useful while logs are still around. |

**Upgrade procedure.** No code changes needed — the codebase already
declares its memory ceiling at 2048 MB in `vercel.json` (raise to 3009
on Pro if desired). Steps:

1. Vercel dashboard → Team → Plan → Upgrade to Pro.
2. (Optional) In `vercel.json`, bump `functions[].memory` from 2048 to
   3009 and `maxDuration` from 60 to 300.
3. Re-deploy. The same code now runs with the higher limits.

The README's "What's still rough" section mentions cold-start hits;
Pro's provisioned concurrency is the production answer.

## 8. Rollback

Vercel keeps every deploy. One click reverts. We don't need anything more
sophisticated for a prototype.

## 9. Local Development

Documented in the README, summarized:

```
git clone <repo>
cd label-verify
cp .env.example .env.local
# fill in keys
npm install
npm run dev          # http://localhost:3000
npm run bench        # benchmark all techniques
npm run gen:corpus   # regenerate synthetic test labels
```

## 10. What We Are Not Deploying

- A database. Stateless prototype.
- A queue (Redis, etc.). The per-item function-invocation pattern in
  `ARCHITECTURE.md` §5 plus an in-memory `batchId` index is sufficient.
- A separate API service. The Next.js app is the API.
- A local VLM container. The network-restricted contingency is OCR-only
  graceful degradation, not a heavy local model.
- A staging environment beyond per-PR preview deploys.
