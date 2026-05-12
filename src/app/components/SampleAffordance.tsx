"use client";

import { SAMPLES, type Sample } from "@/lib/samples";

interface SampleAffordanceProps {
  readonly onPick: (sample: Sample, file: File) => void;
  readonly disabled?: boolean;
}

/**
 * "Try a sample" affordance — three buttons, one per expected verdict.
 * Fetches the static sample image, packages it as a File, and hands it to
 * the parent with the matching declared-fields payload pre-populated.
 *
 * Visible on the empty home screen so a non-technical reviewer can see
 * an end-to-end result without filling a form. UI-SPEC.md §4.
 */
export function SampleAffordance({ onPick, disabled }: SampleAffordanceProps) {
  async function activate(sample: Sample) {
    if (disabled) return;
    const resp = await fetch(sample.imageUrl);
    const blob = await resp.blob();
    const file = new File([blob], `${sample.id}.png`, { type: "image/png" });
    onPick(sample, file);
  }

  return (
    <section
      aria-labelledby="samples-heading"
      className="rounded-lg border border-slate-200 bg-white p-5 dark:border-slate-700 dark:bg-slate-900"
    >
      <h3 id="samples-heading" className="text-label font-semibold uppercase tracking-wide text-slate-500 dark:text-slate-400">
        Try a sample
      </h3>
      <p className="mt-1 text-sm text-slate-600 dark:text-slate-300">
        Pre-populated examples so you can see end-to-end results without
        filling the form. One of each verdict type.
      </p>
      <div className="mt-4 grid grid-cols-1 gap-3 sm:grid-cols-3">
        {SAMPLES.map((s) => (
          <button
            key={s.id}
            type="button"
            onClick={() => activate(s)}
            disabled={disabled}
            className={`group flex min-h-[88px] flex-col items-start gap-2 rounded-md border bg-slate-50 p-3 text-left transition-colors hover:bg-slate-100 disabled:cursor-not-allowed disabled:opacity-60 dark:bg-slate-800 dark:hover:bg-slate-700 ${verdictRing(s.expectedVerdict)}`}
            aria-label={`Try the ${s.id} sample`}
          >
            <span className="text-label font-semibold uppercase tracking-wide text-slate-500 dark:text-slate-400">
              Expected: <span className={verdictText(s.expectedVerdict)}>{s.expectedVerdict.toUpperCase()}</span>
            </span>
            <span className="text-sm font-medium text-slate-800 dark:text-slate-100">{s.label}</span>
            <span className="text-xs text-slate-600 dark:text-slate-400">{s.shortDescription}</span>
          </button>
        ))}
      </div>
    </section>
  );
}

function verdictRing(v: Sample["expectedVerdict"]): string {
  switch (v) {
    case "pass":
      return "border-green-300 hover:border-green-400 dark:border-green-700 dark:hover:border-green-500";
    case "fail":
      return "border-red-300 hover:border-red-400 dark:border-red-700 dark:hover:border-red-500";
    case "review":
      return "border-yellow-300 hover:border-yellow-400 dark:border-yellow-700 dark:hover:border-yellow-500";
  }
}
function verdictText(v: Sample["expectedVerdict"]): string {
  switch (v) {
    case "pass":
      return "text-verdict-pass dark:text-green-400";
    case "fail":
      return "text-verdict-fail dark:text-red-400";
    case "review":
      return "text-verdict-review dark:text-yellow-400";
  }
}
