import { describe, expect, it } from "vitest";
import { render, screen } from "@testing-library/react";
import { BatchProgress } from "@/app/components/BatchProgress";

// Component-level coverage for the determinate batch progress bar.
// Real-time tick behavior + the XHR-driven uploadFraction flow are
// exercised end-to-end by the Playwright suite; here we just lock the
// per-phase copy and the progressbar aria contract so future copy
// changes are explicit.

describe("BatchProgress", () => {
  it("renders nothing when phase is idle", () => {
    const { container } = render(
      <BatchProgress
        phase="idle"
        imageCount={3}
        appCount={1}
        elapsedMs={0}
      />,
    );
    expect(container).toBeEmptyDOMElement();
  });

  it("shows upload phase with real upload fraction when provided", () => {
    render(
      <BatchProgress
        phase="uploading"
        imageCount={3}
        appCount={1}
        uploadFraction={0.5}
        elapsedMs={1000}
      />,
    );
    // Wave-35j: upload phase = 0..25 % of the bar (was 0..30 % pre-
    // wave-35j; tightened because upload is a small fraction of the
    // total wall-clock on a typical batch). 50 % through upload =
    // 12.5 % → rounded to 13.
    const bar = screen.getByRole("progressbar");
    expect(bar).toHaveAttribute("aria-valuenow", "13");
    expect(screen.getByText(/Uploading 3 images \+ 1 application file/i)).toBeInTheDocument();
  });

  it("shows pairing phase copy with the 4-stage description", () => {
    render(
      <BatchProgress
        phase="pairing"
        imageCount={5}
        appCount={1}
        elapsedMs={3000}
      />,
    );
    expect(screen.getByText(/Pairing on the server/i)).toBeInTheDocument();
    expect(
      screen.getByText(/inline-manifest → filename → content → broadcast/i),
    ).toBeInTheDocument();
  });

  it("shows verifying phase with the SERVER's effective concurrency (wave-34 fix)", () => {
    // The component used to hardcode `concurrency 2` — stale from
    // wave-12, off by 6× after the server bumped to 12. Now the
    // value flows from the API response and is clamped to the batch
    // size. The copy reads "N in parallel" instead of "concurrency N"
    // because that's more reviewer-friendly. Wave-35j bumped the
    // server default 12 → 16 with the 2 GB memory bump in vercel.json.
    render(
      <BatchProgress
        phase="verifying"
        imageCount={6}
        appCount={1}
        elapsedMs={5000}
        concurrency={16}
      />,
    );
    // 6 items, concurrency cap 16 → effective 6 (the server clamps
    // via Math.min(MAX_INLINE_CONCURRENCY, job.items.length)).
    // Wave-35j: verifying copy also surfaces an "≈ X of N done"
    // estimate so the reviewer sees real-feeling progress.
    expect(
      screen.getByText(/Verifying 6 images \(6 in parallel\) — ≈ \d+ of 6 done/i),
    ).toBeInTheDocument();
  });

  it("single-image batches use the simple verifying copy (no ≈ 0 of 1 jarring)", () => {
    render(
      <BatchProgress
        phase="verifying"
        imageCount={1}
        appCount={1}
        elapsedMs={1000}
        concurrency={16}
      />,
    );
    // For a 1-image batch the "≈ 0 of 1 done" copy would be jarring
    // (clamped to imageCount-1=0); fall back to the simple form.
    expect(screen.getByText(/Verifying 1 image…/i)).toBeInTheDocument();
  });

  it("progressbar always has aria-valuemin=0 / aria-valuemax=100", () => {
    render(
      <BatchProgress
        phase="verifying"
        imageCount={4}
        appCount={1}
        elapsedMs={0}
      />,
    );
    const bar = screen.getByRole("progressbar");
    expect(bar).toHaveAttribute("aria-valuemin", "0");
    expect(bar).toHaveAttribute("aria-valuemax", "100");
    expect(bar).toHaveAttribute("aria-label", "Batch verification progress");
  });

  it("caps the bar at 95 % during verifying so finalising has a visible 5-point jump (wave-35j)", () => {
    // Wave-35j: lowered the verifying-phase ceiling 98 → 95 so the
    // `finalising` transition has a visible 5-point jump (the
    // previous 2-point jump was too small to register). This pins
    // the cap deliberately so a future "make the bar smoother"
    // change can't silently push it back up.
    render(
      <BatchProgress
        phase="verifying"
        imageCount={2}
        // Far past the per-image budget — should clamp to 95 %.
        elapsedMs={1_000_000}
        appCount={1}
      />,
    );
    const bar = screen.getByRole("progressbar");
    const v = Number(bar.getAttribute("aria-valuenow"));
    expect(v).toBe(95);
  });

  it("finalising phase shows 95% (wave-35j: was 98%; the new 5-point jump matters)", () => {
    render(
      <BatchProgress
        phase="finalising"
        imageCount={3}
        appCount={1}
        elapsedMs={10_000}
      />,
    );
    const bar = screen.getByRole("progressbar");
    expect(bar).toHaveAttribute("aria-valuenow", "95");
    expect(screen.getByText(/Finalising results/i)).toBeInTheDocument();
  });
});
