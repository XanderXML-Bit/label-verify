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
export async function GET() {
  const start = performance.now();
  let tesseract: "ok" | "skipped" | "failed" = "ok";
  try {
    await warmupTesseract();
  } catch (err) {
    tesseract = "failed";
    console.warn(
      `[warmup] tesseract warmup failed: ${(err as Error).message}`,
    );
  }
  return NextResponse.json({
    ok: true,
    tesseract,
    warmupMs: Math.round(performance.now() - start),
  });
}
