import type { Verdict, ImageQuality } from "@/lib/types";

// Dark-mode chip tuning notes — these were the trickiest colors to land:
// the verdict palette has to feel "green / red / amber" on both a #ffffff
// panel and a slate-900 panel. Using the same `text-verdict-*` token (a
// mid-saturation hue at AA contrast on white) on slate-900 produces muddy
// text. Solution: swap to a brighter `text-{color}-300` and tint the fill
// with the dark-{color}-950 variant so it reads as a colored chip, not a
// flat block. Rings move to `-{color}-700` so the boundary doesn't
// disappear into the panel.
const VERDICT_STYLES: Record<Verdict, string> = {
  pass: "bg-green-100 text-verdict-pass ring-1 ring-inset ring-green-300 dark:bg-green-950 dark:text-green-300 dark:ring-green-700",
  fail: "bg-red-100 text-verdict-fail ring-1 ring-inset ring-red-300 dark:bg-red-950 dark:text-red-300 dark:ring-red-700",
  review: "bg-yellow-100 text-verdict-review ring-1 ring-inset ring-yellow-300 dark:bg-yellow-950 dark:text-yellow-200 dark:ring-yellow-700",
};

const VERDICT_LABEL: Record<Verdict, string> = {
  pass: "PASS",
  fail: "FAIL",
  review: "REVIEW",
};

const VERDICT_ICON: Record<Verdict, string> = {
  pass: "✓",
  fail: "✗",
  review: "⚠",
};

const QUALITY_STYLES: Record<ImageQuality, string> = {
  good: "bg-blue-50 text-quality-good ring-1 ring-inset ring-blue-300 dark:bg-blue-950 dark:text-blue-300 dark:ring-blue-700",
  low: "bg-amber-50 text-quality-low ring-1 ring-inset ring-amber-300 dark:bg-amber-950 dark:text-amber-300 dark:ring-amber-700",
  bad: "bg-orange-100 text-quality-bad ring-1 ring-inset ring-orange-400 dark:bg-orange-950 dark:text-orange-300 dark:ring-orange-700",
};

const QUALITY_LABEL: Record<ImageQuality, string> = {
  good: "Good",
  low: "Low",
  bad: "Re-photograph",
};

export function VerdictChip({
  verdict,
  size = "md",
  ariaLabel,
}: {
  readonly verdict: Verdict;
  readonly size?: "sm" | "md" | "lg";
  /** Override the default "Verdict PASS/FAIL/REVIEW" aria-label. Used by
   *  the Gov-Warning subscore rows so a screen reader hears
   *  "Caps verdict PASS", "Bold verdict PASS", etc. rather than four
   *  identical "Verdict PASS" announcements. UI audit C-5. */
  readonly ariaLabel?: string;
}) {
  const sizing =
    size === "lg"
      ? "text-base px-4 py-2"
      : size === "sm"
        ? "text-xs px-2 py-0.5"
        : "text-sm px-3 py-1";
  return (
    <span
      aria-label={ariaLabel ?? `Verdict ${VERDICT_LABEL[verdict]}`}
      className={`inline-flex items-center gap-1.5 rounded-full font-semibold ${VERDICT_STYLES[verdict]} ${sizing}`}
    >
      <span aria-hidden>{VERDICT_ICON[verdict]}</span>
      {VERDICT_LABEL[verdict]}
    </span>
  );
}

export function QualityChip({
  quality,
  size = "md",
}: {
  readonly quality: ImageQuality;
  readonly size?: "sm" | "md" | "lg";
}) {
  const sizing =
    size === "lg"
      ? "text-base px-4 py-2"
      : size === "sm"
        ? "text-xs px-2 py-0.5"
        : "text-sm px-3 py-1";
  return (
    <span
      aria-label={`Image quality ${QUALITY_LABEL[quality]}`}
      className={`inline-flex items-center gap-1.5 rounded-full font-semibold ${QUALITY_STYLES[quality]} ${sizing}`}
    >
      <span aria-hidden>{quality === "good" ? "●" : "○"}</span>
      {QUALITY_LABEL[quality]}
    </span>
  );
}
