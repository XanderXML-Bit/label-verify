# Production Smoke Test

A 5-minute manual smoke script to confirm a live LabelVerify deployment
is healthy. Run this **after every production deploy** and **before
sharing the URL with a reviewer**.

Replace `BASE_URL` below with the URL you are testing. For the
prototype that's `https://label-verify-six.vercel.app`; on a fork
deploy it'll be whatever Vercel handed you (e.g.
`https://label-verify-<hash>.vercel.app`).

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
     "fallback": "gpt-5.4-nano",
     "providers": { "google": true, "openai": true, "anthropic": false, "openrouter": false },
     "debugTokenEnabled": true,
     "version": "a1b2c3d",
     "timestamp": "2026-05-12T...",
     "notes": []
   }
   ```
   (The field name is `fallback`, not `fallbackModel`. The detailed
   shape was renamed when the code-review pass caught the drift.)
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

The batch flow uses the SAME upload dropzone as single-verify — no
separate batch page. Drop 2 or more images and the UI flips to batch
mode automatically.

1. On the home page, drag three label images (e.g. three from
   `test-data-combined/labels/`) into the upload area. The state
   transitions to "Batch upload — 3 images".
2. Pick a pairing path:
   - **Auto-pair (per-image apps):** drop application files (PDF /
     JSON / CSV / MD / TXT / DOCX) with filename stems matching the
     images. The pairing summary in the response shows the matched
     pairs.
   - **Inline-manifest:** drop one CSV or JSON file with a `filename`
     column / key plus the N images. The server auto-detects the
     multi-row manifest and pairs each row to its matching image —
     no separate per-image app files needed.
   - **Broadcast:** drop one single-product application file + N
     images of the same product. The server broadcasts the declared
     payload to every image and surfaces a warning so the operator
     can reject post-hoc.
   - **Paste manifest:** if no application files are dropped, the UI
     surfaces a textarea you can paste a CSV manifest into.
3. Click **Verify batch**.
4. **Expected:** Within ~15 seconds:
   - A virtualized table renders three rows.
   - On Vercel the POST returns inline terminal results (no SSE) and
     all rows paint at once with their verdicts; on local dev the
     SSE path may stream per-item events instead. Either rendering
     is correct.
   - **Download JSON** and **Download CSV** buttons appear once all
     three finish.
5. **Failure looks like:**
   - Stream stalls after 1–2 rows → likely Hobby plan timeout (see
     plan note in checklist). Either reduce batch size for the demo
     or upgrade to Pro.
   - All three rows error → either the vision key is broken or the
     manifest is malformed.

---

## Check 5 — URL-input verify (skipped in current UI)

The deployed UI does not surface a URL-input mode; the public surface
is drag-and-drop + file picker only. The `/api/verify` route still
accepts a JSON body with `{url, declared}` (see `docs/openapi.yaml`)
for programmatic use; covered by the unit tests in
`src/tests/api-verify.test.ts`, not by manual smoke.

If you need an end-to-end URL probe, curl the API directly:

```bash
curl -X POST https://label-verify-six.vercel.app/api/verify \
  -H 'content-type: application/json' \
  -d '{"url":"https://example.com/label.jpg","declared":{ ... }}'
```

Expected: same `VerifyResponse` shape as the multipart path.

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
> **URL tested:** `https://label-verify-six.vercel.app`

If any check fails, do not share the URL. Fix the root cause, redeploy,
and re-run **all six** checks from the top — a fix in one place can
regress another.
