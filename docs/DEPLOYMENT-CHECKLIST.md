# Deployment Checklist

A step-by-step runbook to get LabelVerify live on Vercel at
`labelverify.zendren.net`. Written for someone who has never deployed a
Next.js app before — every click is spelled out. Allow 60–90 minutes for
the first run, mostly DNS propagation time.

The authoritative production knobs (region, per-function memory, per-route
timeouts) live in [`../vercel.json`](../vercel.json). Do not edit them in
the Vercel UI — change them in the repo and redeploy.

---

## Plan note: Hobby vs Pro

The streaming batch route (`/api/verify/batch/[id]/stream`) is configured
for `maxDuration: 300` seconds in `vercel.json`. That value **requires the
Pro plan**. On Hobby, Vercel silently caps function timeouts at 60s and
the batch stream will be cut off mid-way through any batch larger than a
few items.

**If you are deploying on Hobby (free) for the demo:**

- Single-image verify, health, warmup, and the URL-input flow all work
  inside the 60s Hobby cap. The reviewer's primary path is fine.
- Long batches will truncate. Demonstrate with a 3–5 item batch only, or
  upgrade to Pro ($20/month, cancellable after the demo) before submitting
  the link.

The `vercel.json` `maxDuration: 300` is harmless on Hobby — Vercel ignores
the over-cap value rather than failing the deploy.

---

## Pre-deploy: collect environment variables

You will paste these into Vercel in Step 2. Have them ready first.

| Variable | Required? | Where to get it |
|---|---|---|
| `GOOGLE_API_KEY` | **Yes** — primary vision path | https://aistudio.google.com → "Get API key" |
| `OPENAI_API_KEY` | Optional fallback | https://platform.openai.com/api-keys |
| `ANTHROPIC_API_KEY` | Optional fallback | https://console.anthropic.com → Settings → API Keys |
| `MODEL_PRIMARY` | Yes | Set to `gemini-3.1-flash-lite` |
| `MODEL_FALLBACK` | Yes | Set to `gpt-5.4-nano` |
| `VISION_TIMEOUT_MS` | Yes | Set to `60000` |
| `RATE_LIMIT_PER_MIN` | Yes | Set to `60` |
| `MAX_BATCH_SIZE` | Yes | Set to `1000` |
| `DEBUG_TOKEN` | Optional | Any random string. Enables `/api/debug/last`. Leave unset to hide that route. |

A populated `.env.local` (locally, never committed) is the easiest source —
copy each line into Vercel.

---

## Step 1: Connect the GitHub repo to Vercel

1. Go to https://vercel.com/new.
2. Sign in with the GitHub account that owns `XanderXML-Bit/label-verify`.
3. The first time, Vercel asks for GitHub permissions — grant access to
   the `label-verify` repository.
4. On the import page, find `label-verify` in the list and click
   **Import**.
5. On the configuration screen:
   - **Framework Preset**: should auto-detect as **Next.js**. If not,
     pick it manually.
   - **Root Directory**: leave as `./`.
   - **Build / Output / Install Command**: leave all defaults. Vercel
     reads `vercel.json` for the rest.
6. **Do not click Deploy yet** — environment variables come next.

---

## Step 2: Configure environment variables

Still on the import screen, expand the **Environment Variables** section.

1. For each variable in the table above, add a row: paste the name,
   paste the value, leave the three environment checkboxes
   (Production / Preview / Development) **all checked**.
2. Sensitive keys (`GOOGLE_API_KEY`, `OPENAI_API_KEY`, etc.) — Vercel
   automatically marks them as encrypted secrets. You will not be able to
   read them back after saving.
3. Double-check spelling. `GOOGLE_API_KEY` with a typo silently breaks
   the primary path and the app falls back to OCR-only.

(If you already deployed and need to add a variable later: Project →
Settings → Environment Variables → Add. You **must redeploy** for new
vars to take effect — just pushing them in does nothing to the running
function.)

---

## Step 3: First deploy

1. Click **Deploy**.
2. Watch the build log. Expect ~2 minutes. Steps you should see:
   - "Cloning github.com/..." (5s)
   - "Installing dependencies" (60–90s)
   - "Running `next build`" (30–60s)
   - "Deployment Ready"
3. When it finishes, Vercel shows a confetti screen with a URL like:
   `label-verify-xyz123.vercel.app`
4. **Copy this URL.** This is your fallback link if the custom domain
   misbehaves. Paste it into the submission notes immediately so you
   don't lose it.

If the build fails, jump to **Troubleshooting** at the bottom.

---

## Step 4: Smoke test from a clean browser

Before touching DNS, prove the deploy works.

1. Open the `*.vercel.app` URL in an **incognito / private window**
   (no cached cookies, no logged-in state).
2. The home page should render within 2–3 seconds. If you see a generic
   404 or a "deployment failed" page, jump to Troubleshooting.
3. Drag-and-drop one of the sample images from `test-data/labels/` (any
   `.jpg` will do) onto the upload zone.
4. Within ~5 seconds you should see a result screen with a verdict
   (PASS / FAIL / REVIEW) and per-field rows.
5. If you see "REVIEW — model unavailable" on the first try, that is the
   cold-start fallback. Run a second time; it should now PASS.

If smoke passes, continue to Step 5. If not, see Troubleshooting.

---

## Step 5: DNS for `labelverify.zendren.net`

The `zendren.net` zone lives on Cloudflare.

1. Log in to Cloudflare → select the `zendren.net` zone → **DNS** in the
   left sidebar.
2. Click **Add record**:
   - **Type**: `CNAME`
   - **Name**: `labelverify`
   - **Target**: `cname.vercel-dns.com`
   - **Proxy status**: **DNS only** (gray cloud, **not** orange).
     Vercel handles SSL itself; routing through Cloudflare's proxy
     causes a cert mismatch.
   - **TTL**: Auto.
3. Save the record.
4. Back in Vercel → your project → **Settings → Domains**.
5. Type `labelverify.zendren.net` into the input box and click **Add**.
6. Vercel will show "Configuration: Valid" within a minute or two once
   the CNAME has propagated. If it sticks on "Invalid Configuration",
   wait 5 minutes and refresh — global DNS can take a while.

---

## Step 6: SSL verification

1. Once Vercel marks the domain as "Valid", it automatically requests a
   Let's Encrypt certificate.
2. Cert issuance is normally ~1 minute but can take up to 24 hours on
   first attempt for a new zone.
3. Open `https://labelverify.zendren.net` in a fresh incognito window.
   Confirm:
   - The padlock icon is closed (no "Not secure" warning).
   - Clicking the padlock → "Connection is secure" → certificate is
     issued by Let's Encrypt / R3 and the subject matches the domain.
4. If the cert is still pending after 30 minutes, go to Vercel →
   Domains → click the warning icon next to the domain → **Refresh**.

---

## Step 7: Post-deploy smoke

Run [`PRODUCTION-SMOKE.md`](./PRODUCTION-SMOKE.md) against
`https://labelverify.zendren.net` (or the `*.vercel.app` URL if DNS is
still pending). Five minutes, six checks. Every one of them must pass.

---

## Step 8: Submission package

Once smoke passes, fill in the submission notes with all three URLs:

- **Live demo (custom domain):** https://labelverify.zendren.net
- **Live demo (fallback):** https://label-verify-xyz123.vercel.app
- **GitHub repo:** https://github.com/XanderXML-Bit/label-verify
- **Walkthrough video:** (record a 2–3 min Loom showing the smoke
  script in real time)

---

## Troubleshooting

**Build failure: "Module not found: sharp"**
Vercel didn't install the Linux-x64 binary. Check that `sharp` is in
`dependencies` (not `devDependencies`) in `package.json`. Trigger a
fresh deploy from the Vercel dashboard with **Redeploy → Clear build
cache**.

**Cold-start timeout (first request after 10+ min idle)**
The `/api/verify` route allocates 2048 MB (Hobby plan cap) and loads sharp + Tesseract
on first hit — that's ~2s of cold-start tax. The UI's warmup pinger
(home page → `/api/warmup`) prevents this for any reviewer who lands
on `/` first. If you suspect cold starts are biting, just refresh once.

**"REVIEW — model unavailable" on every request**
The `GOOGLE_API_KEY` is wrong, missing, or rate-limited. In Vercel
Project → Settings → Environment Variables, confirm `GOOGLE_API_KEY` is
present and the value has no leading/trailing whitespace. Redeploy
after any edit.

**Vision API rate limits (429)**
Gemini Flash free tier is 15 req/min. For a demo that's plenty. If a
batch demo hits it, either upgrade Gemini billing or run the demo with
a smaller batch (5–10 items).

**Sharp WASM / native module error in logs**
`serverExternalPackages: ["sharp", "tesseract.js"]` in
`next.config.js` keeps Next's bundler from inlining native binaries.
If a future Next upgrade breaks this contract, the error message will
mention "Cannot find module './build/Release/sharp-linuxmusl-x64.node'"
or similar. Pin Next or set `outputFileTracingIncludes`.

**Custom domain SSL takes more than 24 hours**
Almost always a DNS misconfiguration. Verify the CNAME with
`dig labelverify.zendren.net CNAME +short` — it should return
`cname.vercel-dns.com.` (note the trailing dot). If you see Cloudflare's
proxy IPs instead, the orange cloud is still on — go back to Step 5.3.

---

## Rollback

Every deploy is preserved. To revert:

1. Vercel Project → **Deployments** tab.
2. Find the last known-good deployment (each shows a commit SHA + time).
3. Click the `⋯` menu → **Promote to Production**.
4. The custom domain is rerouted within ~10 seconds.

No build, no waiting. This is the safety net for the reviewer demo.
