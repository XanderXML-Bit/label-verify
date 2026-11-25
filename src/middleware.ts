import { NextResponse, type NextRequest } from "next/server";
import { requestIdFor } from "./lib/request-id";

// Every request gets an X-Request-Id
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
// Cap the inbound value at 128 chars, require ≥ 8 chars (so a single
// character or short string can't pollute log greps + can't collide
// trivially with another request's id), and strip anything that isn't
// ASCII alphanumeric / dash / underscore so a malicious client can't
// smuggle log-injection sequences into our logging substrate.
//
// The inbound id is correlation-only — it does NOT gate any auth
// decision. Bearer-gated routes still check Authorization regardless
// of what id the client supplied.

export function middleware(req: NextRequest): NextResponse {
  const id = requestIdFor(req.headers);

  const requestHeaders = new Headers(req.headers);
  requestHeaders.set("x-request-id", id);

  const res = NextResponse.next({ request: { headers: requestHeaders } });
  res.headers.set("X-Request-Id", id);
  return res;
}

export const config = {
  matcher: [
    "/api/((?!(?:verify(?:/batch)?|extract|application/parse)/?$).*)",
    {
      // Next.js buffers bodies for middleware matches. Let these routes
      // handle uploads and set response IDs without cloning the stream.
      source: "/api/:upload(verify(?:/batch)?|extract|application/parse)",
      missing: [
        { type: "header", key: "content-length", value: "0*[1-9][0-9]*" },
        { type: "header", key: "transfer-encoding" },
      ],
    },
  ],
};
