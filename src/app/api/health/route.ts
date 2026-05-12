import { NextResponse } from "next/server";

export const runtime = "nodejs";

/**
 * Liveness + configuration probe.
 *
 * Public response (unauthenticated): minimal — `{ ok, ready, service }`.
 * The page-load ApiStatusBanner only needs `ready` to know whether to
 * render a warning.
 *
 * Detailed response (gated by `Authorization: Bearer <DEBUG_TOKEN>`):
 * model + fallback IDs, git SHA, provider matrix, notes. This is the
 * same info the front-page banner-pinger used to consume directly —
 * we keep that working by ALSO accepting the request from the
 * Next.js page's own origin (same-host). When DEBUG_TOKEN is unset,
 * the detailed response stays on for development convenience.
 *
 * Why: the previous payload leaked deployment fingerprint (git SHA +
 * exact provider matrix) to anonymous callers, which a determined
 * attacker could pivot on. 2026-05-12 security audit finding #7.
 */
export async function GET(req: Request) {
  const hasGoogle = Boolean(process.env.GOOGLE_API_KEY);
  const hasOpenAi = Boolean(process.env.OPENAI_API_KEY);
  const hasAnthropic = Boolean(process.env.ANTHROPIC_API_KEY);
  const hasOpenRouter = Boolean(process.env.OPENROUTER_API_KEY);
  const hasDebugToken = Boolean(process.env.DEBUG_TOKEN);
  const ready = hasGoogle;

  // Detect privileged callers. Two paths:
  //   1. Authorization: Bearer <DEBUG_TOKEN>
  //   2. Same-origin request from the deployment's own host (the
  //      page-load ApiStatusBanner. Vercel sets x-vercel-deployment-url
  //      on requests routed through its CDN.)
  const auth = req.headers.get("authorization") ?? "";
  const tokenOk =
    !hasDebugToken ||
    auth === `Bearer ${process.env.DEBUG_TOKEN}`;
  const sameOrigin = (() => {
    const referer = req.headers.get("referer");
    const host = req.headers.get("host");
    if (!referer || !host) return false;
    try {
      const u = new URL(referer);
      return u.host === host;
    } catch {
      return false;
    }
  })();
  const detailedOk = tokenOk || sameOrigin;

  if (!detailedOk) {
    // Public response — just enough for the banner.
    return NextResponse.json({
      ok: true,
      service: "label-verify",
      ready,
    });
  }

  return NextResponse.json({
    ok: true,
    service: "label-verify",
    model: process.env.MODEL_PRIMARY ?? "gemini-3.1-flash-lite",
    fallback: process.env.MODEL_FALLBACK ?? null,
    version: process.env.VERCEL_GIT_COMMIT_SHA?.slice(0, 7) ?? "dev",
    timestamp: new Date().toISOString(),
    providers: {
      google: hasGoogle,
      openai: hasOpenAi,
      anthropic: hasAnthropic,
      openrouter: hasOpenRouter,
    },
    debugTokenEnabled: hasDebugToken,
    ready,
    notes: hasGoogle
      ? []
      : [
          "GOOGLE_API_KEY missing — /api/verify will 500 with a configuration error. Add it in Vercel Project → Settings → Environment Variables and redeploy.",
        ],
  });
}
