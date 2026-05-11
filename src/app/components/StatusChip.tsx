import type { Verdict, ImageQuality } from "@/lib/types";

const VERDICT_STYLES: Record<Verdict, string> = {
  pass: "bg-green-100 text-verdict-pass ring-1 ring-inset ring-green-300",
  fail: "bg-red-100 text-verdict-fail ring-1 ring-inset ring-red-300",
  review: "bg-yellow-100 text-verdict-review ring-1 ring-inset ring-yellow-300",
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
  good: "bg-blue-50 text-quality-good ring-1 ring-inset ring-blue-300",
  low: "bg-amber-50 text-quality-low ring-1 ring-inset ring-amber-300",
  bad: "bg-orange-100 text-quality-bad ring-1 ring-inset ring-orange-400",
};

const QUALITY_LABEL: Record<ImageQuality, string> = {
  good: "Good",
  low: "Low",
  bad: "Re-photograph",
};

export function VerdictChip({
  verdict,
  size = "md",
}: {
  readonly verdict: Verdict;
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
      aria-label={`Verdict ${VERDICT_LABEL[verdict]}`}
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
