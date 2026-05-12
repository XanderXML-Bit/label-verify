import { NextResponse } from "next/server";
import { getStats, peekQueue } from "@/lib/review-queue";

export const runtime = "nodejs";

// ─── /api/queue ─────────────────────────────────────────────────────────────
//
// Reviewer view onto the human-review queue. Same gating contract as
// /api/debug/last: the route returns 404 when DEBUG_TOKEN is unset (so a
// deployment that hasn't opted in looks identical to one where the route
// doesn't exist), and 401 on a missing/incorrect bearer when the token IS set.
//
// Query params:
//   ?limit=<n>   — return at most N items (default: all pending)

export async function GET(req: Request) {
  const token = process.env.DEBUG_TOKEN;
  if (!token) {
    return NextResponse.json({ error: "Not found" }, { status: 404 });
  }
  const auth = req.headers.get("authorization") ?? "";
  if (auth !== `Bearer ${token}`) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  const url = new URL(req.url);
  const limitRaw = url.searchParams.get("limit");
  const limit =
    typeof limitRaw === "string" && limitRaw.trim()
      ? Math.max(1, Math.min(200, Number(limitRaw) || 0))
      : undefined;

  const items = peekQueue(limit);
  const stats = getStats();
  return NextResponse.json({ stats, items });
}
