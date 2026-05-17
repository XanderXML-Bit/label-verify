"use client";

import { useEffect, useState } from "react";

const STORAGE_KEY = "labelverify:reviewer";

/**
 * Reviewer-id badge for regulator-defensible audit trails.
 *
 * Wave-34 added a reviewer-identification slot so every verification
 * (single, batch row, queue resolve) can be stamped with WHO ran it.
 * Without this, a 6-month-later TTB audit of a PASS verdict has no
 * record of which operator's eyes were on the case. The field is
 * intentionally optional (the prototype must keep its zero-friction
 * "drop a label, see a verdict" path) — but when set, it sticks in
 * `localStorage` and is included in:
 *   • JSON / CSV / PDF result exports
 *   • the `Audit detail` expandable on result cards
 *   • the (future) /api/queue/[id]/resolve `resolvedBy` field
 *
 * The badge is a header-level affordance (next to the theme + mode
 * toggles) so it's discoverable from any screen without cluttering
 * the per-verification form. Storage is the same pattern used by
 * ThemeToggle + ModeToggle so the UX is consistent.
 */
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
    // SSR / pre-hydration: render a stable placeholder so layout
    // doesn't shift after mount.
    return (
      <span
        aria-hidden
        className="hidden sm:inline-block min-h-[36px] min-w-[140px] rounded-md border border-slate-200 px-3 py-1.5 text-xs text-transparent dark:border-slate-700"
      >
        Reviewer:
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
          aria-label="Reviewer ID — name, initials, or employee ID"
          className="min-h-[36px] w-44 rounded-md border border-slate-300 bg-white px-2 py-1 text-sm text-slate-900 focus:border-blue-500 focus:outline-none focus:ring-1 focus:ring-blue-500 dark:border-slate-600 dark:bg-slate-800 dark:text-slate-100"
        />
        <button
          type="submit"
          className="min-h-[36px] rounded-md bg-blue-600 px-2 py-1 text-xs font-semibold text-white hover:bg-blue-700"
          aria-label="Save reviewer ID"
        >
          Save
        </button>
        <button
          type="button"
          onClick={() => setEditing(false)}
          className="min-h-[36px] rounded-md border border-slate-300 px-2 py-1 text-xs text-slate-600 hover:bg-slate-100 dark:border-slate-600 dark:text-slate-300 dark:hover:bg-slate-800"
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
          ? `Reviewer: ${value}. Click to change.`
          : "Set reviewer ID for the audit trail"
      }
      title="Stamps verifications with your name / initials for the regulator audit trail. Stored in this browser only."
      className="min-h-[36px] rounded-md border border-slate-200 bg-white px-2 py-1 text-xs text-slate-700 hover:bg-slate-50 dark:border-slate-700 dark:bg-slate-900 dark:text-slate-200 dark:hover:bg-slate-800"
    >
      <span className="hidden sm:inline">Reviewer:&nbsp;</span>
      {value ? (
        <span className="font-mono">{value}</span>
      ) : (
        <span className="text-slate-500 dark:text-slate-400">+ set ID</span>
      )}
    </button>
  );
}
