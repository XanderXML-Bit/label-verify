import { NextResponse } from "next/server";
import { checkDebugBearer } from "@/lib/debug-token";
import {
  getRecentTraces,
  getTraceById,
  type VerifyTrace,
} from "@/lib/debug-trace";

export const runtime = "nodejs";

// ─── /api/debug/last ────────────────────────────────────────────────────────
//
// Reviewer introspection for the most recent verification(s). Gated by the
// `DEBUG_TOKEN` env var. The route deliberately returns 404 when the token is
// unset so a deployment that hasn't opted into debug mode looks identical to
// one where the path simply doesn't exist — see DEPLOYMENT.md §7.

const OCR_REDACTION_CAP = 1000;

interface RedactedTrace extends Omit<VerifyTrace, "ocrText"> {
  ocrText: string | null;
  ocrTextTruncated: boolean;
}

function redact(trace: VerifyTrace): RedactedTrace {
  if (trace.ocrText === null) {
    return { ...trace, ocrText: null, ocrTextTruncated: false };
  }
  const truncated = trace.ocrText.length > OCR_REDACTION_CAP;
  return {
    ...trace,
    ocrText: truncated
      ? trace.ocrText.slice(0, OCR_REDACTION_CAP)
      : trace.ocrText,
    ocrTextTruncated: truncated,
  };
}

export async function GET(req: Request) {
  const token = process.env.DEBUG_TOKEN;

  // Without DEBUG_TOKEN configured, pretend the route doesn't exist. This
  // avoids confirming the endpoint's presence to unauthenticated probes —
  // important because a 401 would tell a scanner there's something here.
  if (!token) {
    return NextResponse.json({ error: "Not found" }, { status: 404 });
  }

  // Constant-time bearer check. Avoid logging the supplied header anywhere.
  const auth = req.headers.get("authorization") ?? "";
  if (!checkDebugBearer(auth, token)) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  const url = new URL(req.url);
  const id = url.searchParams.get("id");

  if (id) {
    const trace = getTraceById(id);
    if (!trace) {
      return NextResponse.json({ error: "Trace not found" }, { status: 404 });
    }
    return NextResponse.json({ trace: redact(trace) });
  }

  const traces = getRecentTraces().map(redact);
  return NextResponse.json({ count: traces.length, traces });
}
