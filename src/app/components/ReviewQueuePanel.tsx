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
  /** Inline token entry — replaces the previous `window.prompt()` call. */
  const [showTokenInput, setShowTokenInput] = useState(false);
  const [tokenDraft, setTokenDraft] = useState("");

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
    if (existing) {
      setHasToken(true);
      setOpen(true);
      setState({ kind: "loading" });
      void loadQueue(fetchFn, existing).then(setState);
      return;
    }
    // No token yet — surface an inline password input rather than a
    // browser modal. The input mounts below the panel header.
    setShowTokenInput(true);
    setTokenDraft("");
  }

  function submitToken(e: React.FormEvent) {
    e.preventDefault();
    if (typeof window === "undefined") return;
    const t = tokenDraft.trim();
    if (!t) return;
    window.sessionStorage.setItem(TOKEN_STORAGE_KEY, t);
    setShowTokenInput(false);
    setHasToken(true);
    setOpen(true);
    setState({ kind: "loading" });
    void loadQueue(fetchFn, t).then(setState);
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
          {state.kind === "empty" && (
            <p className="mt-1 text-sm text-slate-500 dark:text-slate-400">
              Items appear here when the verifier needs a human judgment on
              borderline cases — typically low extractor confidence on a
              field that the comparator still passed, or a Gov-Warning
              subscore in the review band.
            </p>
          )}
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

      {showTokenInput && !hasToken && (
        <form
          onSubmit={submitToken}
          className="mt-3 rounded-md border border-slate-200 bg-slate-50 p-3 dark:border-slate-700 dark:bg-slate-800/60"
        >
          <label
            htmlFor={`${TOKEN_STORAGE_KEY}-input`}
            className="block text-sm font-medium text-slate-700 dark:text-slate-200"
          >
            Reviewer access code
          </label>
          <p className="mt-1 text-xs text-slate-500 dark:text-slate-400">
            This prototype gates the queue behind a server-configured access
            code. Demo reviewers can request one from the maintainer; without
            it the queue stays hidden by design.
          </p>
          <div className="mt-2 flex flex-wrap gap-2">
            <input
              id={`${TOKEN_STORAGE_KEY}-input`}
              type="password"
              autoComplete="off"
              spellCheck={false}
              value={tokenDraft}
              onChange={(e) => setTokenDraft(e.target.value)}
              autoFocus
              className="min-h-[44px] flex-1 rounded-md border border-slate-300 bg-white px-3 py-2 text-sm text-slate-900 focus:border-blue-500 focus:outline-none focus:ring-1 focus:ring-blue-500 dark:border-slate-600 dark:bg-slate-900 dark:text-slate-100 dark:focus:border-blue-400 dark:focus:ring-blue-400"
              placeholder="Access code"
            />
            <button
              type="submit"
              disabled={!tokenDraft.trim()}
              className="min-h-[44px] rounded-md bg-slate-900 px-4 py-2 text-sm font-semibold text-white hover:bg-slate-700 disabled:cursor-not-allowed disabled:opacity-60 dark:bg-blue-600 dark:hover:bg-blue-500"
            >
              Submit
            </button>
            <button
              type="button"
              onClick={() => setShowTokenInput(false)}
              className="min-h-[44px] rounded-md border border-slate-300 px-4 py-2 text-sm text-slate-700 hover:bg-slate-100 dark:border-slate-600 dark:text-slate-200 dark:hover:bg-slate-700"
            >
              Cancel
            </button>
          </div>
        </form>
      )}

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
          "Queue endpoint is disabled (no reviewer access code configured on the server).",
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
