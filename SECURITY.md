# Security policy

LabelVerify is a take-home prototype, not a production system, but
treats security as a first-class concern because TTB-regulated label
data could plausibly contain personally identifying information (the
producer field is a brewer/distiller and may name an individual).

## Reporting a vulnerability

For security-relevant issues, **please don't open a public GitHub
issue**. Email <xandermlopez@gmail.com> with:

- A description of the vulnerability,
- A reproduction (curl / Playwright / steps),
- The deployment URL where you reproduced it (almost certainly
  https://label-verify-six.vercel.app).

Expect a reply within 48 hours during the take-home review window.
After review wraps, the prototype is unmaintained — open a public
issue at that point if needed.

## Threat model

The prototype runs as a Vercel-hosted Next.js app:

- **Untrusted inputs:** label images (uploaded or URL-fetched),
  application files (PDF/CSV/JSON/MD/TXT/image), declared-fields JSON.
  All inputs can be attacker-controlled.
- **Trusted operators:** the API keys for Gemini, OpenAI, OpenRouter,
  set in Vercel's environment variables. The prototype does not
  authenticate end users.
- **Data lifecycle:** all uploads are processed in-memory inside the
  serverless function and never persisted. There is no database, no
  S3 bucket, no log archive that retains uploaded images.
- **No authentication / authorization.** Every visitor can hit the
  same endpoints; rate-limiting prevents abuse but doesn't gate
  access.

## Mitigations in place

A non-exhaustive list of safeguards already in the deployed code.
See `vercel.json`, `src/middleware.ts`, `src/lib/input-handlers.ts`,
and the per-route handlers for the exact implementations.

### Network & transport
- HTTPS-only via Vercel's automatic TLS.
- HSTS, `X-Content-Type-Options: nosniff`, `X-Frame-Options: DENY`,
  `Referrer-Policy: strict-origin-when-cross-origin`, full
  `Content-Security-Policy` (`default-src 'self'; img-src 'self' data:
  blob:; connect-src 'self'; frame-ancestors 'none'`),
  `Permissions-Policy` deny-list on sensitive APIs. All defined in
  `vercel.json`.

### SSRF / URL fetching
- The `/api/verify` and `/api/extract` URL-input paths run every
  URL through an allowlist before fetching:
  - Reject RFC1918 private ranges, loopback, link-local, CGNAT
    (100.64/10), 255.255.255.255 multicast.
  - Reject non-canonical IPv4 forms (decimal, hex, octal literals)
    used to bypass naive string-prefix checks.
  - Reject `file://`, `gopher://`, anything not http/https.
  - Manually follow redirects, re-validating at every hop.
- Implementation in `src/lib/input-handlers.ts`, tested in
  `src/tests/input-handlers.test.ts` and `input-handlers-extra.test.ts`.

### Upload validation
- Strict MIME allowlist per endpoint:
  - Image routes: `image/jpeg`, `image/png`, `image/webp`,
    `image/heic`, `image/heif`. SVG/GIF/BMP rejected with 415.
  - Application routes: above + `application/pdf`,
    `application/json`, `text/csv`, `text/markdown`, `text/plain`.
- Per-file size caps: 10 MB images, 5 MB application PDFs, 1 MB
  text inputs. Batch route additionally enforces a 5 GB
  Content-Length pre-check before buffering the multipart body
  (DoS guard).
- PDF text is extracted via pdfjs-dist with a hard page cap; only
  the first page is rendered to an image for vision input.

### Prompt-injection defense
- Tesseract OCR text is wrapped in an `<untrusted_ocr>...
  </untrusted_ocr>` block before being sent to the vision model,
  with a length cap (4 KB), control-character strip, and a
  closing-tag escape so a label can't break out of the block via
  carefully crafted glyphs.
- Vision extraction prompt Rule #11 explicitly instructs the model
  to ignore any instructions found inside the `<untrusted_ocr>`
  block.
- See `src/lib/vision/prompts.ts` and `src/lib/ocr/sanitise.ts`.

### Rate limiting
- Per-IP token bucket on `/api/verify`, `/api/extract`,
  `/api/application/parse`. Default 60/min per IP, configurable via
  `RATE_LIMIT_PER_MIN`.
- Implementation in `src/lib/rate-limit.ts`, tested in
  `src/tests/rate-limit.test.ts`.

### Producer-comparator hardening
- The `compareProducer` implicit-USA country inference (when the
  printed label lacks a country marking but the address shows a US
  state) requires:
  - A strict 2-letter US state code (regex `^[A-Z]{2}$`), AND
  - At least one corroborating component (city, postal code, or
    street) matches between extracted and declared.
- Prevents a model hallucination of `state="ME"` from single-
  handedly passing an obviously-foreign label.
- Tested in `src/tests/producer-spoof-resistance.test.ts` and
  `producer-country-inference.test.ts`.

### Observability
- Every `/api/*` request gets an `X-Request-Id` header (UUIDv4
  unless the client sent a valid one). Echoed in both the request
  and response so vendor support tickets can quote one id end-to-
  end. Log lines include the id; users can paste it when
  reporting a failure. See `src/middleware.ts`.

### Debug surfaces
- `/api/debug/last` (in-memory verify trace ring buffer) is gated
  on `Authorization: Bearer ${DEBUG_TOKEN}`. When `DEBUG_TOKEN` is
  unset, the endpoint refuses ALL access — secure-by-default.
- `/api/health` returns a minimal `{ok, service, ready}` shape to
  cross-origin / anonymous callers; same-origin callers and
  Bearer-authed callers get the detailed shape with provider keys
  status.

### Dependency posture
- TypeScript strict mode; no `any` in production code paths
  (verified by tsc).
- Next.js 15 + React 19 + Vitest 2 — kept current as of
  2026-05-12. No known-CVE dependencies in `npm audit`.

## Known unmitigated gaps

This is a prototype, so we acknowledge:

- **No CSRF tokens.** Endpoints accept multipart/form-data and JSON
  from any origin (the CSP locks down `frame-ancestors` and the
  rate-limit + missing-cookie posture make this lower-risk for a
  no-auth app, but a production fork should add CSRF protection
  before introducing sessions).
- **No request body signing.** A man-in-the-middle who already
  defeated TLS could alter the declared-fields JSON. Out of scope
  for the prototype; production would mint per-session HMACs.
- **No fine-grained rate limiting per endpoint.** The bucket is
  per-IP, shared across `/api/verify`, `/api/extract`, and
  `/api/application/parse`. A noisy client could exhaust all three
  with one. Tracked as item R4 in `docs/REMAINING-IMPROVEMENTS.md`.

## Vendor data handling

- **Gemini (Google AI Studio):** Per Google's API policy, AI Studio
  free-tier inputs may be used for model improvement. The deployed
  demo runs on AI Studio for cost reasons; a TTB-deployable fork
  should switch to Vertex AI (no data retention for paid usage).
- **OpenAI:** Production tier (`gpt-5.4-nano`) is contractually
  not used for training (per OpenAI's API DPA). Fallback only —
  not the primary path.
- **OpenRouter:** Used only by the bake-off harness, not the
  deployed verify endpoint. Different keys, different scope.

## Audit trail

All security-relevant changes are tagged `Security:` in
`CHANGELOG.md` and have commit messages explaining the threat
they address. Last security audit pass: 2026-05-12.
