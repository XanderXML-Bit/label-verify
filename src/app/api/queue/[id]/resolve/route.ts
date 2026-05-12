import { NextResponse } from "next/server";
import { checkDebugBearer } from "@/lib/debug-token";
import { markResolved } from "@/lib/review-queue";

export const runtime = "nodejs";

// ─── POST /api/queue/:id/resolve ────────────────────────────────────────────
//
// Mark a queue item as human-resolved. Same DEBUG_TOKEN gating as
// /api/queue (GET). Body: { verdict: "pass" | "fail", resolvedBy, notes? }.

interface RouteContext {
  // Next 15 made params async. Accept either shape for forward-compat with
  // the route-handler typegen in case a future Next bump tightens this.
  params: Promise<{ id: string }> | { id: string };
}

interface ResolveBody {
  verdict?: unknown;
  resolvedBy?: unknown;
  notes?: unknown;
}

export async function POST(req: Request, ctx: RouteContext) {
  const token = process.env.DEBUG_TOKEN;
  if (!token) {
    return NextResponse.json({ error: "Not found" }, { status: 404 });
  }
  const auth = req.headers.get("authorization") ?? "";
  if (!checkDebugBearer(auth, token)) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  const params = await Promise.resolve(ctx.params);
  const { id } = params;
  if (!id) {
    return NextResponse.json({ error: "Missing id" }, { status: 400 });
  }

  let body: ResolveBody;
  try {
    body = (await req.json()) as ResolveBody;
  } catch {
    return NextResponse.json(
      { error: "Body is not valid JSON." },
      { status: 400 },
    );
  }

  if (body.verdict !== "pass" && body.verdict !== "fail") {
    return NextResponse.json(
      { error: "Field 'verdict' must be 'pass' or 'fail'." },
      { status: 400 },
    );
  }
  if (typeof body.resolvedBy !== "string" || !body.resolvedBy.trim()) {
    return NextResponse.json(
      { error: "Field 'resolvedBy' is required." },
      { status: 400 },
    );
  }
  const notes =
    typeof body.notes === "string" && body.notes.trim()
      ? body.notes
      : undefined;

  const ok = markResolved(id, {
    verdict: body.verdict,
    resolvedBy: body.resolvedBy,
    ...(notes ? { notes } : {}),
  });
  if (!ok) {
    return NextResponse.json(
      { error: "Queue item not found (already resolved or evicted)." },
      { status: 404 },
    );
  }
  return NextResponse.json({ ok: true });
}
