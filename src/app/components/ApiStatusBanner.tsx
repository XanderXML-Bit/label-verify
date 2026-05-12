"use client";

import { useEffect, useState } from "react";

// ─── ApiStatusBanner ───────────────────────────────────────────────────────
//
// On page load, hits /api/health and surfaces a yellow banner if the
// primary path isn't ready. The most common cause is a missing
// GOOGLE_API_KEY in the deployment environment — without this banner
// a reviewer would only discover that mid-verify, after the form is
// filled and Submit is clicked. With it, the surface state is visible
// the moment the page mounts.
//
// The banner stays hidden when everything is healthy (ready: true with
// no warning notes). Failure to reach /api/health at all is also
// silent — that's a transient browser/network issue, not a
// configuration problem we want to claim to know about.

interface HealthResponse {
  ok: boolean;
  ready: boolean;
  model?: string;
  fallback?: string | null;
  notes?: string[];
  providers?: Record<string, boolean>;
}

export function ApiStatusBanner() {
  const [state, setState] = useState<
    { kind: "loading" } | { kind: "ok" } | { kind: "warn"; notes: string[] }
  >({ kind: "loading" });

  useEffect(() => {
    let cancelled = false;
    fetch("/api/health", { cache: "no-store" })
      .then((r) => r.json())
      .then((data: HealthResponse) => {
        if (cancelled) return;
        if (data.ready && (data.notes?.length ?? 0) === 0) {
          setState({ kind: "ok" });
        } else {
          setState({ kind: "warn", notes: data.notes ?? [] });
        }
      })
      .catch(() => {
        // Network failure — don't show a banner. The user will see a
        // proper error if they actually try to verify.
        if (!cancelled) setState({ kind: "ok" });
      });
    return () => {
      cancelled = true;
    };
  }, []);

  if (state.kind !== "warn") return null;

  return (
    <div
      role="alert"
      className="rounded-lg border-l-4 border-yellow-500 bg-yellow-50 p-4 text-sm text-yellow-900 dark:border-yellow-400 dark:bg-yellow-950/60 dark:text-yellow-200"
    >
      <p className="font-semibold">
        <span aria-hidden className="mr-1">⚠</span>
        Service configuration issue
      </p>
      <ul className="mt-1 list-inside list-disc">
        {state.notes.map((n) => (
          <li key={n}>{n}</li>
        ))}
      </ul>
    </div>
  );
}
