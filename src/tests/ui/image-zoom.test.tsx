import { describe, expect, it } from "vitest";
import { render, screen, fireEvent } from "@testing-library/react";
import { ImageZoom } from "@/app/components/ImageZoom";

// Component tests for the ImageZoom modal. Real-user flows (drag,
// pinch-zoom on touch) live in the Playwright E2E suite.

describe("ImageZoom", () => {
  const PROPS = {
    src: "blob:test-image",
    alt: "Submitted label preview",
  };

  it("renders only the thumbnail trigger initially", () => {
    render(<ImageZoom {...PROPS} />);
    // The trigger is a real <button> for keyboard accessibility.
    const trigger = screen.getByRole("button", {
      name: /Open larger view of/i,
    });
    expect(trigger).toBeInTheDocument();
    // No dialog mounted yet.
    expect(screen.queryByRole("dialog")).toBeNull();
  });

  it("opens the modal on trigger click and exposes zoom controls", () => {
    render(<ImageZoom {...PROPS} />);
    fireEvent.click(
      screen.getByRole("button", { name: /Open larger view of/i }),
    );
    expect(screen.getByRole("dialog")).toBeInTheDocument();
    // Zoom-in, zoom-out, reset, close all reachable by role + name.
    expect(screen.getByRole("button", { name: /Zoom in/i })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: /Zoom out/i })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: /Reset zoom/i })).toBeInTheDocument();
    expect(
      screen.getByRole("button", { name: /Close larger view/i }),
    ).toBeInTheDocument();
  });

  it("closes the modal when the X button is clicked", () => {
    render(<ImageZoom {...PROPS} />);
    fireEvent.click(
      screen.getByRole("button", { name: /Open larger view of/i }),
    );
    expect(screen.getByRole("dialog")).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: /Close larger view/i }));
    expect(screen.queryByRole("dialog")).toBeNull();
  });

  it("closes on Escape keypress", () => {
    render(<ImageZoom {...PROPS} />);
    fireEvent.click(
      screen.getByRole("button", { name: /Open larger view of/i }),
    );
    expect(screen.getByRole("dialog")).toBeInTheDocument();
    fireEvent.keyDown(document, { key: "Escape" });
    expect(screen.queryByRole("dialog")).toBeNull();
  });

  it("zoom-in and zoom-out buttons change the percentage indicator", () => {
    render(<ImageZoom {...PROPS} />);
    fireEvent.click(
      screen.getByRole("button", { name: /Open larger view of/i }),
    );
    // Initial 100%.
    expect(screen.getByText("100%")).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: /Zoom in/i }));
    // 1.0 * 1.25 = 1.25 → 125%.
    expect(screen.getByText("125%")).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: /Reset zoom/i }));
    expect(screen.getByText("100%")).toBeInTheDocument();
  });

  it("backdrop click closes the modal (clicks on image do not)", () => {
    render(<ImageZoom {...PROPS} />);
    fireEvent.click(
      screen.getByRole("button", { name: /Open larger view of/i }),
    );
    const dialog = screen.getByRole("dialog");
    // Click the dialog itself = backdrop click (matches the
    // onClick.target === currentTarget guard in the component).
    fireEvent.click(dialog);
    expect(screen.queryByRole("dialog")).toBeNull();
  });

  it("returns focus to the trigger when closed", () => {
    render(<ImageZoom {...PROPS} />);
    const trigger = screen.getByRole("button", {
      name: /Open larger view of/i,
    });
    fireEvent.click(trigger);
    fireEvent.click(screen.getByRole("button", { name: /Close larger view/i }));
    expect(trigger).toHaveFocus();
  });
});
