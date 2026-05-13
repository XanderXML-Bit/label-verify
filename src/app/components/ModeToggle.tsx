"use client";

import { useCallback, useEffect, useState } from "react";

// ─── ModeToggle ─────────────────────────────────────────────────────────────
//
// Header affordance next to ThemeToggle: a segmented control that flips
// between "Simple" and "Detailed" view modes. Simple mode hides
// operator-facing detail (subscores, extractor confidences, model id,
// cost extrapolation, multi-button secondary flows) and surfaces only
// the verdict + a one-sentence reason; Detailed mode shows the full
// current UI.
//
// The choice is persisted to localStorage["labelverify:mode"] and read
// by an inline pre-paint script in layout.tsx so the simple-mode body
// class is set BEFORE React hydrates — avoiding a flash of detailed
// content. Same SSR / hydration contract as ThemeToggle: we render
// "Detailed" on the server (the default), then sync state from the
// data-mode attribute the inline script wrote.

const STORAGE_KEY = "labelverify:mode";

export type ViewMode = "simple" | "detailed";

function isMode(v: unknown): v is ViewMode {
  return v === "simple" || v === "detailed";
}

/**
 * Read the current view mode synchronously. Returns "simple" as the
 * default (so first-time non-technical reviewers land on the simpler
 * surface), unless localStorage has "detailed" stored from a prior
 * session OR the pre-paint script set the data-mode attribute first.
 *
 * Safe to call during render — never throws, always returns a valid
 * mode. Use the `useViewMode` hook in components that need to react
 * to changes.
 */
export function readViewMode(): ViewMode {
  if (typeof document !== "undefined") {
    const attr = document.documentElement.getAttribute("data-mode");
    if (isMode(attr)) return attr;
  }
  if (typeof window !== "undefined") {
    try {
      const stored = window.localStorage.getItem(STORAGE_KEY);
      if (isMode(stored)) return stored;
    } catch {
      // ignore
    }
  }
  return "simple";
}

/**
 * React hook: returns the current view mode and a setter that updates
 * both the document attribute and localStorage.
 */
export function useViewMode(): [ViewMode, (next: ViewMode) => void] {
  // Default to "detailed" on the server so SSR is stable. The post-mount
  // effect below reconciles with whatever the pre-paint script wrote.
  const [mode, setMode] = useState<ViewMode>("detailed");
  useEffect(() => {
    setMode(readViewMode());
    const onStorage = (e: StorageEvent): void => {
      if (e.key === STORAGE_KEY && isMode(e.newValue)) {
        setMode(e.newValue);
      }
    };
    window.addEventListener("storage", onStorage);
    return () => window.removeEventListener("storage", onStorage);
  }, []);
  const change = useCallback((next: ViewMode) => {
    setMode(next);
    if (typeof document !== "undefined") {
      document.documentElement.setAttribute("data-mode", next);
    }
    if (typeof window !== "undefined") {
      try {
        window.localStorage.setItem(STORAGE_KEY, next);
        // Notify other tabs / components listening on the storage event.
        // Dispatch a custom event for in-tab listeners since 'storage'
        // only fires across tabs.
        window.dispatchEvent(
          new StorageEvent("storage", { key: STORAGE_KEY, newValue: next }),
        );
      } catch {
        // ignore
      }
    }
  }, []);
  return [mode, change];
}

export function ModeToggle() {
  const [mode, setMode] = useViewMode();
  const isSimple = mode === "simple";
  return (
    <div
      role="group"
      aria-label="View mode"
      className="inline-flex min-h-[44px] items-center overflow-hidden rounded-md border border-slate-300 bg-white text-sm dark:border-slate-600 dark:bg-slate-800"
    >
      <button
        type="button"
        onClick={() => setMode("simple")}
        aria-pressed={isSimple}
        title="Show only the verdict and the basics (recommended for first-time use)"
        className={
          "px-3 py-2 transition-colors focus:outline-none focus-visible:ring-2 focus-visible:ring-sky-500 " +
          (isSimple
            ? "bg-slate-900 text-white dark:bg-slate-200 dark:text-slate-900"
            : "text-slate-700 hover:bg-slate-100 dark:text-slate-200 dark:hover:bg-slate-700")
        }
      >
        Simple
      </button>
      <button
        type="button"
        onClick={() => setMode("detailed")}
        aria-pressed={!isSimple}
        title="Show every check, subscore, confidence, and timing (recommended for operators)"
        className={
          "border-l border-slate-300 px-3 py-2 transition-colors focus:outline-none focus-visible:ring-2 focus-visible:ring-sky-500 dark:border-slate-600 " +
          (!isSimple
            ? "bg-slate-900 text-white dark:bg-slate-200 dark:text-slate-900"
            : "text-slate-700 hover:bg-slate-100 dark:text-slate-200 dark:hover:bg-slate-700")
        }
      >
        Detailed
      </button>
    </div>
  );
}
