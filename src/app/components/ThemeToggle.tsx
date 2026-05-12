"use client";

import { useCallback, useEffect, useState } from "react";

// ─── ThemeToggle ────────────────────────────────────────────────────────────
//
// Top-right header affordance: a single button that flips between light and
// dark mode. The choice is persisted to localStorage["labelverify:theme"] so
// it survives reloads, and the same key is read by the inline pre-paint
// script in layout.tsx to set <html data-theme="…"> *before* React hydrates
// — that avoids a flash of light content (FOUC) on dark-mode visitors.
//
// SSR / hydration contract:
//   - This component renders an `aria-pressed` button whose initial value
//     must match what the server sent. The server doesn't know the user's
//     stored theme, so we render `aria-pressed="false"` (light) on the
//     server and on the first client paint. The pre-paint script has
//     already corrected the <html data-theme> attribute by then; we sync
//     React's own state from that attribute inside a useEffect after mount.
//   - That sync runs only once and never reads localStorage directly in
//     `useState` — doing so would mismatch the server-rendered "false" with
//     a hydrated "true" and trip React's hydration warning.

const STORAGE_KEY = "labelverify:theme";

type Theme = "light" | "dark";

function isTheme(v: unknown): v is Theme {
  return v === "light" || v === "dark";
}

export function ThemeToggle() {
  // Start as "light". The post-mount effect below reconciles with whatever
  // the pre-paint inline script wrote on <html data-theme>.
  const [theme, setTheme] = useState<Theme>("light");
  const [mounted, setMounted] = useState(false);

  useEffect(() => {
    setMounted(true);
    if (typeof document === "undefined") return;
    const attr = document.documentElement.getAttribute("data-theme");
    if (isTheme(attr)) {
      setTheme(attr);
    }
  }, []);

  const toggle = useCallback(() => {
    setTheme((prev) => {
      const next: Theme = prev === "dark" ? "light" : "dark";
      if (typeof document !== "undefined") {
        document.documentElement.setAttribute("data-theme", next);
      }
      if (typeof window !== "undefined") {
        try {
          window.localStorage.setItem(STORAGE_KEY, next);
        } catch {
          // localStorage may be unavailable (private mode, quota); the
          // visual toggle still works for the session.
        }
      }
      return next;
    });
  }, []);

  const isDark = theme === "dark";

  return (
    <button
      type="button"
      onClick={toggle}
      aria-label="Toggle dark mode"
      aria-pressed={mounted ? isDark : false}
      title={isDark ? "Switch to light mode" : "Switch to dark mode"}
      className="inline-flex min-h-[44px] min-w-[44px] items-center justify-center rounded-md border border-slate-300 bg-white p-2 text-slate-700 transition-colors hover:bg-slate-100 dark:border-slate-600 dark:bg-slate-800 dark:text-slate-200 dark:hover:bg-slate-700"
    >
      {/* Sun (visible in dark mode — clicking returns to light). */}
      <svg
        aria-hidden="true"
        focusable="false"
        width="20"
        height="20"
        viewBox="0 0 24 24"
        fill="none"
        stroke="currentColor"
        strokeWidth="2"
        strokeLinecap="round"
        strokeLinejoin="round"
        className={isDark ? "block" : "hidden"}
      >
        <circle cx="12" cy="12" r="4" />
        <path d="M12 2v2" />
        <path d="M12 20v2" />
        <path d="M4.93 4.93l1.41 1.41" />
        <path d="M17.66 17.66l1.41 1.41" />
        <path d="M2 12h2" />
        <path d="M20 12h2" />
        <path d="M4.93 19.07l1.41-1.41" />
        <path d="M17.66 6.34l1.41-1.41" />
      </svg>
      {/* Moon (visible in light mode — clicking moves to dark). */}
      <svg
        aria-hidden="true"
        focusable="false"
        width="20"
        height="20"
        viewBox="0 0 24 24"
        fill="none"
        stroke="currentColor"
        strokeWidth="2"
        strokeLinecap="round"
        strokeLinejoin="round"
        className={isDark ? "hidden" : "block"}
      >
        <path d="M21 12.79A9 9 0 1 1 11.21 3 7 7 0 0 0 21 12.79z" />
      </svg>
    </button>
  );
}
