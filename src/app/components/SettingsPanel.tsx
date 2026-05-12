"use client";

import { useCallback, useEffect, useState } from "react";
import type { ModelModeId } from "@/lib/model-modes";

// ─── SettingsPanel ──────────────────────────────────────────────────────────
//
// Small collapsible panel above the upload zone that lets the operator pick
// which extractor mode runs on the server. The choice is persisted to
// localStorage under `labelverify:mode` so it survives reloads, and is
// passed back to verifyLabel via the `mode` field on the verify request.
//
// Client-bundle hygiene: this file imports only the `ModelModeId` *type*
// from @/lib/model-modes and re-declares the user-facing display
// catalogue inline. The full model-modes.ts module pulls in vision
// adapters via dynamic import, which the Next.js webpack pass would
// otherwise drag into the client bundle (and `node:crypto` with it).
// Display strings here must stay in lockstep with model-modes.ts's
// `MODES` catalogue; the model-modes.test.ts contract pins the runtime
// half, this file is the UI half.
//
// Design intent:
//   - Collapsed by default. The Default mode is the right choice for most
//     visitors; we don't want to confront a non-technical reviewer with
//     five radio buttons before they upload anything.
//   - Inline summary in the collapsed header ("Default — recommended.")
//     so the current selection is always visible at a glance.
//   - Radio (not select) when expanded: discoverable descriptions and the
//     cost/latency hints sit next to each option, not in a tooltip.

const STORAGE_KEY = "labelverify:mode";

interface ModeDisplay {
  readonly id: ModelModeId;
  readonly label: string;
  readonly description: string;
  readonly approxCostPer1k: string;
  readonly approxLatency: string;
  readonly networkRequired: boolean;
}

// Client-side display catalogue. Mirrors @/lib/model-modes#MODES but
// without the extractor factories, so the heavy server-only imports
// don't leak into the browser bundle.
const MODE_DISPLAY: readonly ModeDisplay[] = [
  {
    id: "default",
    label: "Default",
    description: "Recommended. Uses the MODEL_PRIMARY setting on the server.",
    approxCostPer1k: "~$0.10",
    approxLatency: "~2s P50",
    networkRequired: true,
  },
  {
    id: "fast",
    label: "Fast",
    description: "Fastest, cheapest, very capable. Gemini Flash Lite.",
    approxCostPer1k: "~$0.08",
    approxLatency: "~2s P50",
    networkRequired: true,
  },
  {
    id: "smart",
    label: "Smart",
    description: "Most accurate, slower, costlier. Gemini Pro Preview.",
    approxCostPer1k: "~$1.80",
    approxLatency: "~5s P50",
    networkRequired: true,
  },
  {
    id: "local",
    label: "Local",
    description: "Network-free fallback. Tesseract OCR only, no vision API.",
    approxCostPer1k: "$0.00",
    approxLatency: "~1.5s P50",
    networkRequired: false,
  },
  {
    id: "balanced",
    label: "Balanced",
    description:
      "Recommended for production: catches edge cases. Fast first, escalates to Smart on low confidence.",
    approxCostPer1k: "~$0.20",
    approxLatency: "~3s P50",
    networkRequired: true,
  },
];

const DEFAULT_DISPLAY_ID: ModelModeId = "default";

function getDisplay(id: string): ModeDisplay | undefined {
  return MODE_DISPLAY.find((m) => m.id === (id as ModelModeId));
}

/**
 * Hook returning the currently selected mode id plus a setter that writes
 * through to localStorage. Falls back to `DEFAULT_DISPLAY_ID` on SSR (no
 * window) and on unknown stored values (e.g. a renamed mode from an
 * earlier release).
 */
export function useModelMode(): {
  modeId: ModelModeId;
  setModeId: (id: ModelModeId) => void;
} {
  const [modeId, setModeIdState] = useState<ModelModeId>(DEFAULT_DISPLAY_ID);

  // Hydrate from localStorage after mount. Don't read in useState's
  // initializer — server-rendered HTML must match the first client paint.
  useEffect(() => {
    if (typeof window === "undefined") return;
    const stored = window.localStorage.getItem(STORAGE_KEY);
    if (!stored) return;
    const found = getDisplay(stored);
    if (found) setModeIdState(found.id);
  }, []);

  const setModeId = useCallback((id: ModelModeId) => {
    setModeIdState(id);
    if (typeof window !== "undefined") {
      window.localStorage.setItem(STORAGE_KEY, id);
    }
  }, []);

  return { modeId, setModeId };
}

interface SettingsPanelProps {
  readonly modeId: ModelModeId;
  readonly onModeChange: (id: ModelModeId) => void;
}

export function SettingsPanel({ modeId, onModeChange }: SettingsPanelProps) {
  const [expanded, setExpanded] = useState(false);
  const selected = getDisplay(modeId) ?? getDisplay(DEFAULT_DISPLAY_ID)!;

  return (
    <section
      aria-labelledby="settings-heading"
      className="rounded-lg border border-slate-200 bg-white p-4 dark:border-slate-700 dark:bg-slate-900"
    >
      <header className="flex flex-wrap items-center justify-between gap-2">
        <div>
          <h3
            id="settings-heading"
            className="text-label font-semibold uppercase tracking-wide text-slate-500 dark:text-slate-400"
          >
            Settings
          </h3>
          <p className="mt-1 text-sm text-slate-700 dark:text-slate-200">
            Model mode:{" "}
            <strong className="font-semibold">{selected.label}</strong>
            <span className="text-slate-500 dark:text-slate-400"> — {selected.description}</span>
          </p>
        </div>
        <button
          type="button"
          onClick={() => setExpanded((v) => !v)}
          aria-expanded={expanded}
          aria-controls="settings-options"
          className="min-h-[44px] rounded-md border border-slate-300 px-3 py-2 text-sm text-slate-700 hover:bg-slate-100 dark:border-slate-600 dark:text-slate-200 dark:hover:bg-slate-800"
        >
          {expanded ? "Close settings" : "Open settings"}
        </button>
      </header>

      {expanded && (
        <div id="settings-options" className="mt-4 space-y-2">
          <fieldset>
            <legend className="sr-only">Select a model mode</legend>
            <ul role="radiogroup" aria-label="Model mode" className="space-y-2">
              {MODE_DISPLAY.map((m) => (
                <li key={m.id}>
                  <ModeRadio
                    mode={m}
                    checked={m.id === modeId}
                    onSelect={() => onModeChange(m.id)}
                  />
                </li>
              ))}
            </ul>
          </fieldset>
          <p className="pt-2 text-xs text-slate-500 dark:text-slate-400">
            Your choice is saved in this browser only. Switching modes does
            not redeploy the app; the next verify uses the selected mode.
          </p>
        </div>
      )}
    </section>
  );
}

function ModeRadio({
  mode,
  checked,
  onSelect,
}: {
  readonly mode: ModeDisplay;
  readonly checked: boolean;
  readonly onSelect: () => void;
}) {
  return (
    <label
      className={`flex cursor-pointer items-start gap-3 rounded-md border p-3 transition-colors ${
        checked
          ? "border-blue-400 bg-blue-50 dark:border-blue-500 dark:bg-blue-950"
          : "border-slate-200 bg-slate-50 hover:bg-slate-100 dark:border-slate-700 dark:bg-slate-800 dark:hover:bg-slate-700"
      }`}
    >
      <input
        type="radio"
        name="model-mode"
        value={mode.id}
        checked={checked}
        onChange={onSelect}
        className="mt-1 dark:accent-blue-500"
        aria-describedby={`mode-desc-${mode.id}`}
      />
      <span className="flex-1">
        <span className="flex flex-wrap items-baseline justify-between gap-2">
          <span className="font-medium text-slate-800 dark:text-slate-100">{mode.label}</span>
          <span className="text-xs text-slate-500 dark:text-slate-400">
            {mode.approxLatency} · {mode.approxCostPer1k} / 1k
            {!mode.networkRequired && " · offline"}
          </span>
        </span>
        <span
          id={`mode-desc-${mode.id}`}
          className="mt-1 block text-sm text-slate-600 dark:text-slate-300"
        >
          {mode.description}
        </span>
      </span>
    </label>
  );
}
