import { describe, expect, it } from "vitest";
import { render, screen } from "@testing-library/react";
import { VerifyProgress } from "@/app/components/VerifyProgress";

describe("VerifyProgress", () => {
  it("renders the supplied verb and a progressbar-ish aria-busy region", () => {
    render(<VerifyProgress verb="Checking the label" />);
    // verb appears twice — once visible, once in the sr-only live region.
    expect(screen.getAllByText(/Checking the label/).length).toBeGreaterThan(0);
    // aria-busy="true" on the outer container is the canonical signal
    expect(
      document.querySelector('[aria-busy="true"]'),
    ).not.toBeNull();
  });

  it("the elapsed counter is NOT inside an aria-live region (no 10Hz chatter)", () => {
    render(<VerifyProgress verb="Checking" />);
    const counter = document.querySelector("span.font-mono");
    expect(counter).not.toBeNull();
    // Walk up from the counter; if anything along the way says aria-live,
    // the throttling fix has regressed.
    let node: HTMLElement | null = counter as HTMLElement | null;
    while (node) {
      if (node.getAttribute("aria-live")) {
        throw new Error(
          `Counter is inside aria-live="${node.getAttribute("aria-live")}" — regression of D7.`,
        );
      }
      node = node.parentElement;
    }
  });
});
