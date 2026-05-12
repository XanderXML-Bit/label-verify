import { NextResponse } from "next/server";
import { warmupTesseract } from "@/lib/ocr/tesseract";

export const runtime = "nodejs";

// Touched by the home page on load (DEPLOYMENT.md §6). Keeps the
// serverless function and the Tesseract WASM worker warm so the user's
// first verify call does not pay the cold-start tax.
//
// We wrap the warmup call in an outer try/catch in addition to the
// in-route `.catch()` because tesseract.js can throw synchronously on
// some serverless filesystems (read-only /tmp) when fetching language
// data. Whatever happens, we want this route to ALWAYS return JSON so
// the client-side warmup pinger never breaks the page.
// Bound Tesseract warmup so a stalled WASM init (missing tessdata, blocked
// CDN, Vercel filesystem quirk) can never sink the warmup endpoint past
// the 30s Hobby-plan cap. We'd rather declare warmup "timeout" and let
// the user's first verify call try OCR fresh — the orchestrator already
// races OCR against a 1.5s window and falls back to vision-only.
const WARMUP_BUDGET_MS = 8_000;

// REMAINING-IMPROVEMENTS.md R1: also pull the Gemini SDK into the
// serverless function's module cache during warmup. The SDK is ~150 ms
// of module-load + client-instantiation cost on cold start; doing it
// now means the user's first /api/verify avoids paying that tax. We
// deliberately do NOT make a real network call here — the SDK auth
// handshake happens lazily on first generateContent(), so warming it
// would burn tokens for marginal gain.
async function warmupGemini(): Promise<"ok" | "missing-key" | "failed"> {
  const key = process.env.GOOGLE_API_KEY;
  if (!key) return "missing-key";
  try {
    const mod = await import("@/lib/vision/gemini");
    new mod.GeminiFlashExtractor({ apiKey: key });
    return "ok";
  } catch (err) {
    console.warn(`[warmup] gemini SDK warmup failed: ${(err as Error).message}`);
    return "failed";
  }
}

export async function GET() {
  const start = performance.now();
  let tesseract: "ok" | "timeout" | "failed" = "ok";
  // Run Tesseract + Gemini warmups in parallel — they're independent
  // and we want the wall-clock to be max(tesseract, gemini) ≈ 3 s, not
  // the sum.
  const tess = (async () => {
    try {
      await Promise.race([
        warmupTesseract(),
        new Promise<never>((_, reject) =>
          setTimeout(
            () => reject(new Error(`warmup timeout after ${WARMUP_BUDGET_MS}ms`)),
            WARMUP_BUDGET_MS,
          ),
        ),
      ]);
    } catch (err) {
      const msg = (err as Error).message ?? "";
      tesseract = msg.startsWith("warmup timeout") ? "timeout" : "failed";
      console.warn(`[warmup] tesseract warmup ${tesseract}: ${msg}`);
    }
  })();
  const [, gemini] = await Promise.all([tess, warmupGemini()]);
  return NextResponse.json({
    ok: true,
    tesseract,
    gemini,
    warmupMs: Math.round(performance.now() - start),
  });
}
