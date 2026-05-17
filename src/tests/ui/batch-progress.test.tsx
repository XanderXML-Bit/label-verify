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
    // Upload phase = 0..30 % of the bar; 50 % through upload = 15 %.
    const bar = screen.getByRole("progressbar");
    expect(bar).toHaveAttribute("aria-valuenow", "15");
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
    // because that's more reviewer-friendly.
    render(
      <BatchProgress
        phase="verifying"
        imageCount={6}
        appCount={1}
        elapsedMs={5000}
        concurrency={12}
      />,
    );
    // 6 items, concurrency cap 12 → effective 6 (the server clamps
    // via Math.min(MAX_INLINE_CONCURRENCY, job.items.length)).
    expect(
      screen.getByText(/Verifying 6 images \(6 in parallel\)/i),
    ).toBeInTheDocument();
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

  it("caps the bar at 98 % during verifying so it does not sit at 100 % before results land", () => {
    render(
      <BatchProgress
        phase="verifying"
        imageCount={2}
        // Far past the per-image budget — should clamp to 98 %.
        elapsedMs={1_000_000}
        appCount={1}
      />,
    );
    const bar = screen.getByRole("progressbar");
    const v = Number(bar.getAttribute("aria-valuenow"));
    expect(v).toBeLessThanOrEqual(98);
    expect(v).toBeGreaterThanOrEqual(95);
  });
});
