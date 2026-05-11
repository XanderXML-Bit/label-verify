import { NextResponse } from "next/server";
import { warmupTesseract } from "@/lib/ocr/tesseract";

export const runtime = "nodejs";

// Touched by the home page on load (DEPLOYMENT.md §6). Keeps the
// serverless function and the Tesseract WASM worker warm so the user's
// first verify call does not pay the cold-start tax.
export async function GET() {
  const start = performance.now();
  await warmupTesseract().catch(() => undefined); // never block on warmup
  return NextResponse.json({
    ok: true,
    warmupMs: Math.round(performance.now() - start),
  });
}
