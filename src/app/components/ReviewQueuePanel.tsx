"use client";

import { useCallback, useEffect, useState } from "react";
import type { ReviewQueueItem } from "@/lib/types";

// ─── ReviewQueuePanel ───────────────────────────────────────────────────────
//
// Reviewer-facing affordance for the human-review queue. The /api/queue route
// is DEBUG_TOKEN-gated (same contract as /api/debug/last), so the panel
// starts in its empty state and offers an "Open queue" button. The reviewer
// pastes their token; we hold it in sessionStorage and fetch the queue.
//
// Design choices:
//   - Empty state on first paint. Don't probe the gated endpoint without
//     auth — that would leak a 401 to the browser console for every visitor.
//   - sessionStorage (not localStorage): the token shouldn't outlive the tab.
//   - The panel surfaces only minimal info (filename, reasons). The full
//     verifyResponse is in the response but we render just the headline.
//   - "labels need human review" — small, definite, plural-aware.

const TOKEN_STORAGE_KEY = "labelverify:debug-token";

interface QueueResponse {
  stats: {
    pending: number;
    resolvedToday: number;
    medianAgeMs: number;
  };
  items: ReviewQueueItem[];
}

interface PanelState {
  kind: "empty" | "loading" | "loaded" | "error";
  data?: QueueResponse;
  error?: string;
}

export function ReviewQueuePanel({
  /** Render override for tests; production code defaults to the real fetch. */
  fetchFn = globalThis.fetch.bind(globalThis),
}: {
  readonly fetchFn?: typeof fetch;
} = {}) {
  const [state, setState] = useState<PanelState>({ kind: "empty" });
  const [open, setOpen] = useState(false);
  const [hasToken, setHasToken] = useState(false);

  // Auto-load on mount if a token is already stashed from a prior session.
  useEffect(() => {
    if (typeof window === "undefined") return;
    const t = window.sessionStorage.getItem(TOKEN_STORAGE_KEY);
    if (t) {
      setHasToken(true);
      void loadQueue(fetchFn, t).then(setState);
    }
    // We don't watch `fetchFn` here intentionally — tests pass it once at
    // mount time. Re-running the effect on every render would double-fetch.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const refresh = useCallback(async () => {
    if (typeof window === "undefined") return;
    const t = window.sessionStorage.getItem(TOKEN_STORAGE_KEY);
    if (!t) return;
    setState({ kind: "loading" });
    setState(await loadQueue(fetchFn, t));
  }, [fetchFn]);

  function handleOpenQueue() {
    if (typeof window === "undefined") return;
    const existing = window.sessionStorage.getItem(TOKEN_STORAGE_KEY);
    let token = existing;
    if (!token) {
      // eslint-disable-next-line no-alert -- prototype affordance for reviewers
      const entered = window.prompt(
        "Reviewer access — paste the DEBUG_TOKEN configured in the deployment.",
      );
      if (!entered || !entered.trim()) return;
      token = entered.trim();
      window.sessionStorage.setItem(TOKEN_STORAGE_KEY, token);
    }
    setHasToken(true);
    setOpen(true);
    setState({ kind: "loading" });
    void loadQueue(fetchFn, token).then(setState);
  }

  const pending = state.data?.stats.pending ?? 0;
  const recent = state.data?.items.slice(0, 5) ?? [];

  return (
    <section
      aria-labelledby="review-queue-heading"
      className="rounded-lg border border-slate-200 bg-white p-4 dark:border-slate-700 dark:bg-slate-900"
    >
      <header className="flex flex-wrap items-center justify-between gap-2">
        <div>
          <h3
            id="review-queue-heading"
            className="text-label font-semibold uppercase tracking-wide text-slate-500 dark:text-slate-400"
          >
            Human review queue
          </h3>
          <p className="mt-1 text-base text-slate-800 dark:text-slate-100">
            {state.kind === "loaded" ? (
              <>
                <strong>{pending}</strong>{" "}
                {pending === 1 ? "label needs" : "labels need"} human review.
              </>
            ) : state.kind === "loading" ? (
              "Loading queue…"
            ) : state.kind === "error" ? (
              <span className="text-red-700 dark:text-red-400">{state.error}</span>
            ) : (
              "No labels currently waiting on human review."
            )}
          </p>
        </div>
        <div className="flex gap-2">
          {hasToken && (
            <button
              type="button"
              onClick={() => void refresh()}
              aria-label="Refresh review queue"
              className="min-h-[44px] rounded-md border border-slate-300 px-3 py-2 text-sm text-slate-700 hover:bg-slate-100 dark:border-slate-600 dark:text-slate-200 dark:hover:bg-slate-800"
            >
              Refresh
            </button>
          )}
          <button
            type="button"
            onClick={() => {
              if (open && hasToken) {
                setOpen(false);
              } else {
                handleOpenQueue();
              }
            }}
            className="min-h-[44px] rounded-md bg-slate-900 px-3 py-2 text-sm font-semibold text-white hover:bg-slate-700 dark:bg-blue-600 dark:hover:bg-blue-500"
          >
            {open && hasToken ? "Close queue" : "Open queue"}
          </button>
        </div>
      </header>

      {open && state.kind === "loaded" && recent.length > 0 && (
        <ul className="mt-4 divide-y divide-slate-100 border-t border-slate-100 dark:divide-slate-800 dark:border-slate-800">
          {recent.map((item) => (
            <li key={item.id} className="py-3">
              <div className="flex flex-wrap items-baseline justify-between gap-2">
                <div className="font-medium text-slate-800 dark:text-slate-100">
                  {item.filename ?? item.declared.brand_name ?? item.id}
                </div>
                <span className="text-xs text-slate-500 dark:text-slate-400">
                  {timeAgo(Date.now() - item.enqueuedAt)} • {item.source}
                </span>
              </div>
              {item.reasons.length > 0 && (
                <ul className="mt-1 list-disc space-y-0.5 pl-5 text-sm text-slate-600 dark:text-slate-300">
                  {item.reasons.slice(0, 3).map((r, i) => (
                    <li key={i}>{r}</li>
                  ))}
                </ul>
              )}
            </li>
          ))}
        </ul>
      )}

      {open && state.kind === "loaded" && recent.length === 0 && (
        <p className="mt-3 text-sm text-slate-600 dark:text-slate-300">
          Queue is empty. Submit a borderline label to see it appear here.
        </p>
      )}
    </section>
  );
}

async function loadQueue(
  fetchFn: typeof fetch,
  token: string,
): Promise<PanelState> {
  try {
    const res = await fetchFn("/api/queue?limit=10", {
      headers: { authorization: `Bearer ${token}` },
    });
    if (res.status === 404) {
      return {
        kind: "error",
        error:
          "Queue endpoint is disabled (DEBUG_TOKEN not configured on the server).",
      };
    }
    if (res.status === 401) {
      // Drop the bad token so the next click re-prompts.
      if (typeof window !== "undefined") {
        window.sessionStorage.removeItem(TOKEN_STORAGE_KEY);
      }
      return { kind: "error", error: "Token rejected. Click Open queue to try again." };
    }
    if (!res.ok) {
      return { kind: "error", error: `Queue load failed (HTTP ${res.status}).` };
    }
    const data = (await res.json()) as QueueResponse;
    return { kind: "loaded", data };
  } catch (e) {
    return { kind: "error", error: (e as Error).message };
  }
}

function timeAgo(ms: number): string {
  const s = Math.floor(ms / 1000);
  if (s < 60) return `${s}s ago`;
  const m = Math.floor(s / 60);
  if (m < 60) return `${m}m ago`;
  const h = Math.floor(m / 60);
  if (h < 24) return `${h}h ago`;
  const d = Math.floor(h / 24);
  return `${d}d ago`;
}
