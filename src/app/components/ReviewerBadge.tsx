"use client";

import { useEffect, useState } from "react";

const STORAGE_KEY = "labelverify:reviewer";
const REVIEWER_HINT =
  "Adds your name or initials to the results you export as JSON or PDF. Stored in this browser only.";

/** Read the optional reviewer ID stored by the header badge. */
export function getStoredReviewer(): string {
  if (typeof window === "undefined") return "";
  try {
    return window.localStorage.getItem(STORAGE_KEY) ?? "";
  } catch {
    return "";
  }
}

export function ReviewerBadge() {
  const [value, setValue] = useState("");
  const [editing, setEditing] = useState(false);
  // Hydration guard: localStorage isn't readable during SSR, so we
  // wait until after mount before showing the initial value. Without
  // this guard a server-rendered "" would briefly flash before the
  // useEffect re-paint, identical to the ThemeToggle / ModeToggle
  // patterns elsewhere in this folder.
  const [hydrated, setHydrated] = useState(false);
  useEffect(() => {
    setValue(getStoredReviewer());
    setHydrated(true);
  }, []);

  function commit(next: string): void {
    const trimmed = next.trim().slice(0, 64);
    setValue(trimmed);
    setEditing(false);
    try {
      if (trimmed) window.localStorage.setItem(STORAGE_KEY, trimmed);
      else window.localStorage.removeItem(STORAGE_KEY);
    } catch {
      /* private browsing, quota errors — fall back to in-memory */
    }
  }

  if (!hydrated) {
    // SSR / pre-hydration: render the empty-state button's exact box,
    // made invisible, so the header keeps its size after mount. A
    // placeholder hidden below `sm` let the mobile header controls wrap
    // to a second row on hydration (CLS 0.184 at a 412 px viewport).
    return (
      <span
        aria-hidden
        data-testid="reviewer-badge-placeholder"
        className="invisible inline-flex min-h-[44px] min-w-[44px] items-center rounded-md border border-slate-200 px-2 py-1 text-xs dark:border-slate-700"
      >
        <span className="hidden sm:inline">Reviewer:&nbsp;</span>
        <span>+ set ID</span>
      </span>
    );
  }

  if (editing) {
    return (
      <form
        onSubmit={(e) => {
          e.preventDefault();
          const fd = new FormData(e.currentTarget);
          commit(String(fd.get("reviewer") ?? ""));
        }}
        className="flex items-center gap-1"
      >
        <label className="sr-only" htmlFor="reviewer-id">
          Reviewer ID
        </label>
        <input
          autoFocus
          id="reviewer-id"
          name="reviewer"
          type="text"
          defaultValue={value}
          placeholder="Name or initials"
          maxLength={64}
          aria-label="Reviewer ID (name or initials)"
          className="min-h-[44px] min-w-[44px] w-44 rounded-md border border-slate-300 bg-white px-2 py-1 text-sm text-slate-900 focus:border-blue-500 focus:outline-none focus:ring-1 focus:ring-blue-500 dark:border-slate-600 dark:bg-slate-800 dark:text-slate-100"
        />
        <button
          type="submit"
          className="min-h-[44px] min-w-[44px] rounded-md bg-blue-600 px-2 py-1 text-xs font-semibold text-white hover:bg-blue-700"
          aria-label="Save reviewer ID"
        >
          Save
        </button>
        <button
          type="button"
          onClick={() => setEditing(false)}
          className="min-h-[44px] min-w-[44px] rounded-md border border-slate-300 px-2 py-1 text-xs text-slate-600 hover:bg-slate-100 dark:border-slate-600 dark:text-slate-300 dark:hover:bg-slate-800"
          aria-label="Cancel editing reviewer ID"
        >
          Cancel
        </button>
      </form>
    );
  }

  return (
    <button
      type="button"
      onClick={() => setEditing(true)}
      aria-label={
        value
          ? `Reviewer: ${value}. Select to change.`
          : "Reviewer: + set ID for your exports"
      }
      title={value ? `Reviewer: ${value}. ${REVIEWER_HINT}` : REVIEWER_HINT}
      className="min-h-[44px] min-w-[44px] rounded-md border border-slate-200 bg-white px-2 py-1 text-xs text-slate-700 hover:bg-slate-50 dark:border-slate-700 dark:bg-slate-900 dark:text-slate-200 dark:hover:bg-slate-800"
    >
      <span className="hidden sm:inline">Reviewer:&nbsp;</span>
      {value ? (
        // Cap the width so a long stored ID cannot wrap the header
        // controls at 320 px or wider. The aria-label and title carry the full ID.
        <span className="inline-block max-w-[3rem] truncate align-bottom font-mono min-[360px]:max-w-[4.5rem] sm:max-w-[9rem]">
          {value}
        </span>
      ) : (
        <span className="text-slate-500 dark:text-slate-400">+ set ID</span>
      )}
    </button>
  );
}
