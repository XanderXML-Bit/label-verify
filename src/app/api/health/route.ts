import { NextResponse } from "next/server";

export const runtime = "nodejs";

/**
 * Liveness + configuration probe. Reveals which env-var-driven providers
 * are wired up without exposing the actual key values. Used by the
 * deployment-checklist verify step and by `docs/PRODUCTION-SMOKE.md`.
 */
export async function GET() {
  const hasGoogle = Boolean(process.env.GOOGLE_API_KEY);
  const hasOpenAi = Boolean(process.env.OPENAI_API_KEY);
  const hasAnthropic = Boolean(process.env.ANTHROPIC_API_KEY);
  const hasOpenRouter = Boolean(process.env.OPENROUTER_API_KEY);
  const hasDebugToken = Boolean(process.env.DEBUG_TOKEN);

  return NextResponse.json({
    ok: true,
    service: "label-verify",
    model: process.env.MODEL_PRIMARY ?? "gemini-3.1-flash-lite",
    fallback: process.env.MODEL_FALLBACK ?? null,
    version: process.env.VERCEL_GIT_COMMIT_SHA?.slice(0, 7) ?? "dev",
    timestamp: new Date().toISOString(),
    // Surfacing which keys are present so a reviewer (or curious user)
    // can verify the deployment is correctly configured without a
    // verify-call round-trip. Never expose the keys themselves.
    providers: {
      google: hasGoogle,
      openai: hasOpenAi,
      anthropic: hasAnthropic,
      openrouter: hasOpenRouter,
    },
    debugTokenEnabled: hasDebugToken,
    // First-class operational hint when the primary path is broken.
    // The home-page warmup pinger surfaces this in dev tools, and a
    // user reading the deployed `/api/health` can immediately see
    // what's missing.
    ready: hasGoogle,
    notes: hasGoogle
      ? []
      : [
          "GOOGLE_API_KEY missing — /api/verify will 500 with a configuration error. Add it in Vercel Project → Settings → Environment Variables and redeploy.",
        ],
  });
}
