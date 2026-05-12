# Custom domain — `labelverify.xandermlopez.com`

Bringing the prototype up on a custom domain via Cloudflare DNS →
Vercel. The Vercel deployment continues to host the app; Cloudflare
only provides the DNS record.

## What I (Claude) prepared

- `vercel.json` is already wired for the Vercel project, no edits
  needed for a custom domain.
- `.github/workflows/e2e-live.yml` and
  `.github/workflows/post-deploy-smoke.yml` accept a
  `workflow_dispatch` input `target`, so once the custom domain
  resolves, you can rerun either workflow against
  `https://labelverify.xandermlopez.com` to confirm parity.
- README + this doc reference the custom domain as a future
  alternative to the `*.vercel.app` URL.

## What you (Xander) need to do

### Step 1 — Add the domain in Vercel

1. Sign in at https://vercel.com/dashboard.
2. Open the `label-verify` project.
3. Settings → Domains → Add → enter `labelverify.xandermlopez.com`.
4. Vercel will show you ONE of two options:
   - **CNAME** (recommended for a subdomain): `cname.vercel-dns.com`
   - **A record** (only if your DNS provider can't CNAME a subdomain)

Copy the CNAME target Vercel shows.

### Step 2 — Add the CNAME in Cloudflare

1. Sign in at https://dash.cloudflare.com.
2. Open the `xandermlopez.com` zone.
3. DNS → Records → Add record.
4. Type: `CNAME`. Name: `labelverify`. Target:
   `cname.vercel-dns.com` (or whatever Vercel showed). TTL: Auto.
5. **Proxy status:** for the simplest first pass, set this to
   **"DNS only"** (grey cloud). Cloudflare's proxy CDN can interfere
   with Vercel's edge cache, and we already get HTTPS via Vercel.
   You can switch to "Proxied" (orange cloud) later if you want
   Cloudflare WAF in front, but verify the cert + cache behaviour
   afterwards.
6. Save.

### Step 3 — Wait for cert + DNS

- DNS propagation usually completes in seconds for Cloudflare; a
  few minutes worst-case.
- Vercel automatically provisions a Let's Encrypt cert once the
  DNS resolves — typically within 1–2 minutes after the record
  appears.
- Vercel's Domains page will show **Valid Configuration** + an
  active cert when ready.

### Step 4 — Smoke test the custom URL

Once Vercel reports the cert is live:

```
# Health probe
curl -sS https://labelverify.xandermlopez.com/api/health

# Expected (anonymous public shape):
# {"ok":true,"service":"label-verify","ready":true,"notes":[]}
```

Then trigger the post-deploy smoke workflow manually against the
new URL:

```
gh workflow run post-deploy-smoke.yml \
  -f target=https://labelverify.xandermlopez.com
```

And the live-URL e2e suite:

```
gh workflow run e2e-live.yml \
  -f target=https://labelverify.xandermlopez.com
```

Both should pass with the same green output they get against the
`*.vercel.app` URL.

### Step 5 — Decide which URL to put in the submission

Once both are healthy, either URL works. I'd recommend including
both in the submission:

> **Live demo:** <https://labelverify.xandermlopez.com> (primary)
> **Fallback:** <https://label-verify-six.vercel.app>

If you'd rather submit only one, the custom domain reads more
"polished" — federal reviewers expect a real domain on a
production app.

## If anything goes wrong

- **Vercel says "Invalid Configuration"**: the CNAME isn't
  resolving yet. Wait 5 minutes; if still stuck, double-check the
  record name (`labelverify`, not `labelverify.xandermlopez.com`
  — Cloudflare auto-appends the zone).
- **Browser shows ERR_TOO_MANY_REDIRECTS**: Cloudflare's "Flexible"
  SSL mode conflicts with Vercel's enforced HTTPS. Switch
  Cloudflare's SSL/TLS encryption mode (zone-level setting) to
  **Full (strict)** under SSL/TLS → Overview.
- **/api/health returns Cloudflare's challenge page**: the proxy
  is intercepting. Switch the CNAME to "DNS only" (grey cloud).
- **404 on the root**: Vercel hasn't matched the domain to the
  project. In Vercel → Domains, confirm `labelverify.xandermlopez.com`
  is bound to the `label-verify` project specifically, not a
  different deployment.

## Reverting

If you ever need to remove the custom domain:
1. Vercel → Domains → remove `labelverify.xandermlopez.com`.
2. Cloudflare → DNS → delete the `labelverify` CNAME.

No code changes needed — the app keeps serving on the
`*.vercel.app` URL regardless.
