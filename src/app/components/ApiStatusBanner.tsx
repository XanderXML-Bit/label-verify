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
    | { kind: "loading" }
    | { kind: "ok" }
    | { kind: "warn"; notes: string[] }
    | { kind: "offline" }
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
        // Wave-34 audit fix #16: previously the catch silently
        // resolved to "ok" and a reviewer on a dropped network
        // filled the entire form before discovering the failure
        // at submit time. Now we surface a focused "offline"
        // notice so the reviewer knows up front. The check fires
        // only on the cheap /api/health probe — a real server
        // configuration issue still routes through the .then()
        // branch above.
        if (!cancelled) setState({ kind: "offline" });
      });
    return () => {
      cancelled = true;
    };
  }, []);

  if (state.kind === "loading" || state.kind === "ok") return null;

  if (state.kind === "offline") {
    return (
      <div
        role="alert"
        className="rounded-lg border-l-4 border-amber-500 bg-amber-50 p-4 text-sm text-amber-900 dark:border-amber-400 dark:bg-amber-950/60 dark:text-amber-200"
      >
        <p className="font-semibold">
          <span aria-hidden className="mr-1">⚠</span>
          We can&apos;t reach the verifier
        </p>
        <p className="mt-1">
          Check your network connection — if you&apos;re on a VPN or
          corporate network, the request may be blocked. The verify
          button will still work once the connection comes back.
        </p>
      </div>
    );
  }

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
