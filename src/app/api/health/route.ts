import { NextResponse } from "next/server";
import { checkDebugBearer } from "@/lib/debug-token";

export const runtime = "nodejs";

/**
 * Liveness + configuration probe.
 *
 * Public response (unauthenticated): minimal — `{ ok, ready, service }`
 * plus `notes` so the page-load banner can warn about missing keys.
 *
 * Detailed response (gated by `Authorization: Bearer <DEBUG_TOKEN>`):
 * model + fallback IDs, git SHA, provider matrix, timestamps. When
 * `DEBUG_TOKEN` is unset the detailed response is unreachable — the
 * route stays public-minimal so it can't be used as a deployment
 * fingerprint by anonymous callers.
 *
 * Why the same-origin shortcut was removed: the `Referer` header is set
 * by the browser but can be omitted, spoofed via fetch from any origin,
 * or stripped by privacy extensions — so it was useless as a security
 * boundary and only useful as a deployment fingerprint to attackers.
 * The public banner doesn't need provider details to do its job; it
 * just needs `ready` + a generic `notes` list. 2026-05-12 audit #D12.
 */
export async function GET(req: Request) {
  const hasGoogle = Boolean(process.env.GOOGLE_API_KEY);
  const hasOpenAi = Boolean(process.env.OPENAI_API_KEY);
  const hasAnthropic = Boolean(process.env.ANTHROPIC_API_KEY);
  const hasOpenRouter = Boolean(process.env.OPENROUTER_API_KEY);
  const hasDebugToken = Boolean(process.env.DEBUG_TOKEN);
  const ready = hasGoogle;

  const auth = req.headers.get("authorization") ?? "";
  const tokenOk = hasDebugToken
    ? checkDebugBearer(auth, process.env.DEBUG_TOKEN ?? "")
    : false;

  // Generic, vendor-free notes for the public surface. The banner
  // currently surfaces only the missing-key case; that's actionable
  // without leaking which provider drives the primary path.
  const publicNotes = hasGoogle
    ? []
    : [
        "The verification service is missing a required API key. The operator needs to add it before single-image verifies will run.",
      ];

  if (!tokenOk) {
    return NextResponse.json({
      ok: true,
      service: "label-verify",
      ready,
      notes: publicNotes,
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
