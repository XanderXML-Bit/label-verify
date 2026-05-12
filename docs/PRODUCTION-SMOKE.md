# Production Smoke Test

A 5-minute manual smoke script to confirm a live LabelVerify deployment
is healthy. Run this **after every production deploy** and **before
sharing the URL with a reviewer**.

Replace `BASE_URL` below with whichever URL you are testing:
- `https://labelverify.zendren.net` (custom domain)
- `https://label-verify-<hash>.vercel.app` (fallback)

If any step fails, the deployment is **not** ready to ship. See
[`DEPLOYMENT-CHECKLIST.md`](./DEPLOYMENT-CHECKLIST.md) Troubleshooting.

---

## Check 1 — Home page loads (30 seconds)

1. Open `BASE_URL` in a fresh **incognito / private window**.
2. **Expected:** Home page renders within 3 seconds. Headline reads
   something like "Verify a label". Upload zone is visible. No
   spinner stuck on screen.
3. **Failure looks like:**
   - Vercel "DEPLOYMENT_NOT_FOUND" page → wrong URL.
   - Blank white screen for 10+ seconds → build artifact missing,
     check Vercel build logs.
   - "This site can't be reached" → DNS or SSL not ready (Step 5/6 of
     the checklist).

---

## Check 2 — Health endpoint (15 seconds)

1. In a new tab, open `BASE_URL/api/health`. The endpoint returns a
   minimal public shape to anonymous callers and a detailed shape
   only with `Authorization: Bearer ${DEBUG_TOKEN}` (see SECURITY.md
   for the auth contract).
2. **Public expected (no auth):**
   ```json
   {
     "ok": true,
     "service": "label-verify",
     "ready": true,
     "notes": []
   }
   ```
3. **Detailed expected (with `Authorization: Bearer <DEBUG_TOKEN>`):**
   ```json
   {
     "ok": true,
     "service": "label-verify",
     "ready": true,
     "model": "gemini-3.1-flash-lite",
     "fallbackModel": "gpt-5.4-nano",
     "providers": { "google": true, "openai": true },
     "version": "a1b2c3d",
     "timestamp": "2026-05-12T...",
     "notes": []
   }
   ```
4. **Failure looks like:**
   - `404` → routing broken, redeploy.
   - `ready: false` with `notes` listing a missing key → set the
     missing env var on Vercel, redeploy.
   - `model: "dev"` and `version: "dev"` (only in the detailed
     shape) → environment variables not set; revisit checklist
     Step 2.
   - 500 with no body → check Vercel function logs.

---

## Check 3 — Single-image verify (90 seconds)

1. Back on the home page, drag-and-drop one sample image from
   `test-data/labels/` onto the upload zone (any `.jpg` works; pick
   one you know the ground truth for).
2. The "Declared values" form should appear. Fill in the brand name and
   ABV that match the ground-truth JSON for that image.
3. Click **Verify**.
4. **Expected:** Within ~5 seconds:
   - A result screen appears with one of three verdicts: PASS, FAIL,
     or REVIEW.
   - Per-field rows show the declared vs. extracted values with green
     check or red X icons.
   - An "Image quality" panel rates the upload separately from the
     compliance verdict.
5. **Failure looks like:**
   - Spinner over 10 seconds → cold start; refresh, try again. If it
     persists, the function is timing out — check vision API key.
   - "REVIEW — model unavailable" on every attempt → `GOOGLE_API_KEY`
     is missing or wrong (checklist Troubleshooting).
   - 500 error in the network tab → check Vercel function logs for the
     specific error.

---

## Check 4 — 3-item batch (90 seconds)

1. Navigate to the batch upload page (link from the home page).
2. Upload the manifest CSV at `test-data/batch-smoke-3.csv` (if it
   doesn't exist, build a quick one with three rows referencing three
   images you know the ground truth for).
3. Upload the three corresponding image files.
4. Click **Run batch**.
5. **Expected:** Within ~15 seconds:
   - A virtualized table renders three rows.
   - Each row populates with a verdict, one after the other, as the
     SSE stream emits per-item events.
   - "Export CSV" button appears once all three finish.
6. **Failure looks like:**
   - Stream stalls after 1–2 rows → likely Hobby plan timeout (see
     plan note in checklist). Either reduce batch size for the demo
     or upgrade to Pro.
   - All three rows error → either the vision key is broken or the
     CSV manifest is malformed.

---

## Check 5 — URL-input verify (45 seconds)

1. Back to the home page, switch to the **From URL** input mode.
2. Paste a publicly-reachable image URL (any image on imgur,
   Wikipedia, etc.).
3. Fill declared values, click **Verify**.
4. **Expected:** Same 5-second flow as Check 3, with a result screen.
5. **Failure looks like:**
   - "SSRF blocked" → the SSRF filter is doing its job for private/local
     URLs. Try a different public URL.
   - "URL fetch failed" with a public URL → check the function logs;
     might be a transient remote 503.

---

## Check 6 — Static asset caching (15 seconds)

1. Open browser DevTools → Network tab.
2. Refresh the home page.
3. Click any static asset (a `.js` or `.woff2` file in the requests
   list).
4. **Expected:** Response headers include
   `cache-control: public, max-age=31536000, immutable`.
5. **Failure looks like:**
   - `cache-control: no-store` on a `.js` file → the `vercel.json`
     headers block isn't applying. Confirm `vercel.json` is at repo
     root and that the latest commit deployed.

---

## Sign-off

When all six checks pass, the deployment is reviewer-ready. Note the
verified time in your submission notes:

> **Smoke verified at:** `2026-05-11 14:30 ET`
> **Verified by:** `<your name>`
> **URL tested:** `https://labelverify.zendren.net`

If any check fails, do not share the URL. Fix the root cause, redeploy,
and re-run **all six** checks from the top — a fix in one place can
regress another.
