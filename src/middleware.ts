import { NextResponse, type NextRequest } from "next/server";

// Per REMAINING-IMPROVEMENTS.md R2 — every request gets an X-Request-Id
// (UUID v4) on its way in and the same value echoed back in the response
// headers. Two purposes:
//   1. Operators can correlate user-reported failures with server logs
//      ("my verify failed at 14:32 — request id abc123") instead of
//      guessing by timestamp.
//   2. Downstream calls (Gemini, OpenAI) inherit the id via Node fetch's
//      header copy, so vendor support tickets can quote one id end-to-end.
//
// If the client already sent X-Request-Id (e.g. an upstream proxy /
// CDN injected one), honour it — don't clobber operator trace context.
// Cap the inbound value at 128 chars and strip anything that isn't ASCII
// alphanumeric / dash / underscore so a malicious client can't smuggle
// log-injection sequences into our logging substrate.

const SAFE_ID_RE = /^[A-Za-z0-9_-]{1,128}$/;

export function middleware(req: NextRequest): NextResponse {
  const inbound = req.headers.get("x-request-id");
  const id = inbound && SAFE_ID_RE.test(inbound) ? inbound : crypto.randomUUID();

  const requestHeaders = new Headers(req.headers);
  requestHeaders.set("x-request-id", id);

  const res = NextResponse.next({ request: { headers: requestHeaders } });
  res.headers.set("X-Request-Id", id);
  return res;
}

export const config = {
  // Apply to API routes only — page renders don't need a per-request id
  // (and middleware on every static asset is unnecessary cost). Bake-off
  // scripts and the Tesseract WASM worker don't go through this path.
  matcher: ["/api/:path*"],
};
