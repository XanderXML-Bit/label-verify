"use client";

import { useCallback, useEffect, useRef, useState } from "react";

export interface ImageZoomProps {
  /** Source URL — blob: from the user's upload or http for samples. */
  src: string;
  /** Alt text + accessible label on the trigger button. */
  alt: string;
  /** Tailwind classes for the trigger thumbnail (matches existing styling). */
  thumbnailClassName?: string;
}

/**
 * Click-to-zoom image viewer for the result panels.
 *
 * The thumbnail behaves like a button (keyboard- and screen-reader-
 * accessible) and opens a full-viewport modal containing the same
 * image at native size. The modal supports zoom (+ / − / reset),
 * scroll, and closes on Escape or backdrop click. No external
 * dependency.
 *
 * Accessibility:
 *   - Trigger is a real <button> so Tab + Enter / Space activate it.
 *   - Modal is role="dialog" aria-modal, with the alt text echoed as
 *     aria-label.
 *   - Focus moves to the close button on open and back to the trigger
 *     on close (focus trap pattern).
 *   - Escape closes. The overlay close-button is keyboard-reachable
 *     by Tab order.
 */
export function ImageZoom({
  src,
  alt,
  thumbnailClassName,
}: ImageZoomProps) {
  const [open, setOpen] = useState(false);
  const [scale, setScale] = useState(1);
  const triggerRef = useRef<HTMLButtonElement>(null);
  const closeRef = useRef<HTMLButtonElement>(null);
  // Wave-34 audit fix #17: the modal dialog needs a real focus trap.
  // Previous version only handled Escape + zoom keys — Tab was not
  // intercepted, so a keyboard user could Tab out into the
  // background page underneath the overlay. We collect every
  // tabbable element inside the dialog container and cycle focus
  // on Tab / Shift+Tab.
  const dialogRef = useRef<HTMLDivElement>(null);

  const close = useCallback(() => {
    setOpen(false);
    setScale(1);
    // Restore focus to the thumbnail trigger.
    triggerRef.current?.focus();
  }, []);

  // Move focus to the close button when the modal opens, and listen
  // for Escape to close.
  useEffect(() => {
    if (!open) return;
    closeRef.current?.focus();
    const onKey = (e: KeyboardEvent): void => {
      if (e.key === "Escape") {
        e.preventDefault();
        close();
      } else if (e.key === "+" || e.key === "=") {
        e.preventDefault();
        setScale((s) => Math.min(8, s * 1.25));
      } else if (e.key === "-" || e.key === "_") {
        e.preventDefault();
        setScale((s) => Math.max(0.25, s / 1.25));
      } else if (e.key === "0") {
        e.preventDefault();
        setScale(1);
      } else if (e.key === "Tab" && dialogRef.current) {
        // Focus-trap (wave-34 a11y fix). Cycle focus within the
        // dialog so keyboard users can't accidentally Tab out into
        // the background page underneath the overlay.
        const focusables = Array.from(
          dialogRef.current.querySelectorAll<HTMLElement>(
            'button, [href], input, select, textarea, [tabindex]:not([tabindex="-1"])',
          ),
        ).filter(
          (el) => !el.hasAttribute("disabled") && el.tabIndex !== -1,
        );
        if (focusables.length === 0) return;
        const first = focusables[0]!;
        const last = focusables[focusables.length - 1]!;
        const active = document.activeElement as HTMLElement | null;
        if (e.shiftKey) {
          if (active === first || !dialogRef.current.contains(active)) {
            e.preventDefault();
            last.focus();
          }
        } else {
          if (active === last || !dialogRef.current.contains(active)) {
            e.preventDefault();
            first.focus();
          }
        }
      }
    };
    document.addEventListener("keydown", onKey);
    // Lock body scroll while open so background doesn't flicker
    // behind the modal on mobile.
    const prevOverflow = document.body.style.overflow;
    document.body.style.overflow = "hidden";
    return () => {
      document.removeEventListener("keydown", onKey);
      document.body.style.overflow = prevOverflow;
    };
  }, [open, close]);

  return (
    <>
      <button
        ref={triggerRef}
        type="button"
        onClick={() => setOpen(true)}
        className={
          thumbnailClassName ??
          "group block h-full w-full overflow-hidden rounded-md focus:outline-none focus-visible:ring-2 focus-visible:ring-sky-500"
        }
        aria-label={`Open larger view of ${alt}`}
        title="Click to zoom"
      >
        {/* eslint-disable-next-line @next/next/no-img-element -- blob: URL from the user's upload, not a remote image */}
        <img
          src={src}
          alt={alt}
          loading="lazy"
          decoding="async"
          className="h-full max-h-96 w-full cursor-zoom-in rounded-md object-contain transition group-hover:opacity-90"
        />
      </button>

      {open ? (
        <div
          ref={dialogRef}
          role="dialog"
          aria-modal="true"
          aria-label={`Larger view: ${alt}`}
          className="fixed inset-0 z-50 flex flex-col bg-slate-950/90 backdrop-blur-sm"
          onClick={(e) => {
            // Backdrop click closes (but ignore clicks on the image
            // itself or the control bar).
            if (e.target === e.currentTarget) close();
          }}
        >
          <div className="flex items-center justify-between gap-2 border-b border-slate-800 px-3 py-2 text-slate-100">
            <div className="flex items-center gap-2">
              <button
                type="button"
                onClick={() => setScale((s) => Math.max(0.25, s / 1.25))}
                className="rounded border border-slate-700 px-2 py-1 text-sm hover:bg-slate-800 focus:outline-none focus-visible:ring-2 focus-visible:ring-sky-500"
                aria-label="Zoom out"
                title="Zoom out (−)"
              >
                −
              </button>
              <span className="min-w-12 text-center text-sm tabular-nums">
                {Math.round(scale * 100)}%
              </span>
              <button
                type="button"
                onClick={() => setScale((s) => Math.min(8, s * 1.25))}
                className="rounded border border-slate-700 px-2 py-1 text-sm hover:bg-slate-800 focus:outline-none focus-visible:ring-2 focus-visible:ring-sky-500"
                aria-label="Zoom in"
                title="Zoom in (+)"
              >
                +
              </button>
              <button
                type="button"
                onClick={() => setScale(1)}
                className="rounded border border-slate-700 px-2 py-1 text-sm hover:bg-slate-800 focus:outline-none focus-visible:ring-2 focus-visible:ring-sky-500"
                aria-label="Reset zoom"
                title="Reset zoom (0)"
              >
                Reset
              </button>
            </div>
            <button
              ref={closeRef}
              type="button"
              onClick={close}
              className="rounded border border-slate-700 px-3 py-1 text-sm hover:bg-slate-800 focus:outline-none focus-visible:ring-2 focus-visible:ring-sky-500"
              aria-label="Close larger view"
              title="Close (Esc)"
            >
              ✕ Close
            </button>
          </div>
          <div className="flex flex-1 items-start justify-center overflow-auto p-4">
            {/* eslint-disable-next-line @next/next/no-img-element -- same blob: URL as the thumbnail above; next/image is for remote/static assets, not user-uploaded blobs */}
            <img
              src={src}
              alt={alt}
              style={{
                transform: `scale(${scale})`,
                transformOrigin: "top center",
              }}
              className="max-w-full select-none transition-transform duration-100"
              draggable={false}
            />
          </div>
          <div className="border-t border-slate-800 px-3 py-1 text-center text-xs text-slate-400">
            Keyboard: <kbd className="rounded border border-slate-700 px-1">+</kbd>{" "}
            zoom in,{" "}
            <kbd className="rounded border border-slate-700 px-1">−</kbd>{" "}
            zoom out,{" "}
            <kbd className="rounded border border-slate-700 px-1">0</kbd>{" "}
            reset,{" "}
            <kbd className="rounded border border-slate-700 px-1">Esc</kbd>{" "}
            close.
          </div>
        </div>
      ) : null}
    </>
  );
}
