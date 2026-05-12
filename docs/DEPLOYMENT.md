# Deployment

> The reviewer must be able to click a link and use the prototype. This
> document is the operational plan to make that link reliable.

## 1. Target

- **Host:** Vercel (free tier, Hobby plan is sufficient).
- **Domain:** `labelverify.zendren.net` (preferred). Fallback: the default
  `*.vercel.app` URL if DNS propagation slips before the deadline.
- **Region:** `iad1` (us-east-1, same coast as Treasury / DC reviewers — minimizes RTT).

### 1.1 Provision-Today Checklist

DNS + SSL can eat half a day. The provisioning happens *before* the first
extractor is written, so the URL is live and warm by the time the demo
exists. From `TODO.md` Phase 1:

- [ ] Create Vercel project linked to the GitHub repo
- [ ] First push triggers a deploy; the placeholder home page should
      respond within minutes
- [ ] Add the `labelverify.zendren.net` CNAME in Cloudflare
- [ ] Add the domain in Vercel → Domains; wait for SSL
- [ ] Smoke-test from a clean browser
- [ ] Record both URLs (custom + `*.vercel.app`) in the submission

## 2. Why Vercel

- Next.js is first-class on Vercel — zero-config builds.
- Free tier covers the prototype's traffic.
- Edge functions option available if we want to push the API closer to the
  user (we likely won't — vision API calls dominate latency anyway).
- Public URL with HTTPS out of the box (R8).
- Easy to add a custom domain via CNAME on Cloudflare DNS for `zendren.net`.

## 3. Environment Variables

Stored in Vercel project settings (never in the repo):

| Var | Purpose |
|-----|---------|
| `OPENAI_API_KEY` | Optional direct OpenAI backup used only if Gemini primary fails. |
| `MODEL_FALLBACK` | Optional backup model override; defaults to `gpt-5.4-nano`. |
| `GEMINI_RPM_LIMIT` | Optional verified Gemini project RPM from AI Studio; derives interactive batch cap. |
| `RATE_LIMIT_BATCH_PER_MIN` | Optional batch-create rate limit; defaults to 3/min/IP. |
| `RATE_LIMIT_PER_MIN` | Per-IP cap on the public demo. |

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

1. Add `labelverify` CNAME → `cname.vercel-dns.com` on the `zendren.net`
   Cloudflare zone.
2. Add the domain in Vercel project → Domains.
3. Wait for SSL cert issuance (~minutes).

Backup plan if DNS misbehaves: use the auto-generated
`label-verify-<hash>.vercel.app` URL. The submission docs should include
both.

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
- Hard 60 s `AbortSignal` on every vision call. If the call exceeds budget,
  `/api/verify` returns 504 with a clear timeout message; the UI does not
  expose a stronger-model or OCR-only alternate mode.

## 7. Observability

Bare minimum for a prototype:

- Vercel built-in request logs.
- Anonymous `/api/health` returns only `{ ok, service, ready }`; detailed model/provider/version diagnostics require `Authorization: Bearer DEBUG_TOKEN`.
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
| Function timeout | 30 s | up to 300 s | The batch SSE stream needs the longer window; single verifications stay on one fixed path. |
| Function memory | 2 GB | up to 3 GB (per-function override) | The vision call is small; the ceiling matters only if we ever introduce a local VLM. Headroom for `sharp` + `tesseract.js-core` is already comfortable at 2 GB. |
| Concurrency | best-effort | provisioned concurrency available | Reduces cold starts during batch upload/streaming. |
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
- A local VLM container. The network-restricted contingency is a clear 5xx/504 plus optional OpenAI backup
  graceful degradation, not a heavy local model.
- A staging environment beyond per-PR preview deploys.
