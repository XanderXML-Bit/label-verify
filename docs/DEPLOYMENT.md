# Deployment

> The reviewer must be able to click a link and use the prototype. This
> document is the operational plan to make that link reliable.

## 1. Target

- **Host:** Vercel (free tier, Hobby plan is sufficient).
- **Domain:** `labelverify.zendren.net` (preferred). Fallback: the default
  `*.vercel.app` URL if DNS propagation slips before the deadline.
- **Region:** `iad1` (us-east-1, same coast as Treasury / DC reviewers — minimizes RTT).

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
| `OPENROUTER_API_KEY` | Vision model access via OpenRouter (multi-provider). |
| `OPENAI_API_KEY` | Direct OpenAI fallback. |
| `ANTHROPIC_API_KEY` | Direct Claude fallback. |
| `MODEL_PRIMARY` | Model identifier for the primary tier (e.g. `google/gemini-2.0-flash-001`). |
| `MODEL_FALLBACK` | Higher-quality model for low-confidence escalation. |
| `MAX_BATCH_SIZE` | Hard cap on uploads per request (default 300). |
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
  idle has a cold start (~500–1500 ms for Node).
- Mitigation: a tiny "warmup" pinger on the deployed page that hits
  `/api/health` on load. Keeps the function warm during a demo session.
- Tesseract.js WASM is large. We load it on the server only when needed; the
  browser bundle stays slim.

## 7. Observability

Bare minimum for a prototype:

- Vercel built-in request logs.
- `/api/health` returns `{ ok: true, model: MODEL_PRIMARY, version: SHA }`.
- A `/api/debug/last` (gated by an env-only password) returns the last
  request's full pipeline trace — useful if the reviewer reports an issue.

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
- A queue (Redis, etc.). In-memory worker pool is sufficient.
- A separate API service. The Next.js app is the API.
- A staging environment beyond per-PR preview deploys.
