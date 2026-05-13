import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { render, screen, fireEvent } from "@testing-library/react";
import { ModeToggle, readViewMode } from "@/app/components/ModeToggle";

// ModeToggle component tests. SSR/hydration is exercised by the E2E
// suite (mode survives a reload); here we cover the segmented control
// behaviour + localStorage persistence + document attribute write.

describe("ModeToggle", () => {
  beforeEach(() => {
    // Reset the document mode + storage before each test so order-
    // independence holds.
    document.documentElement.removeAttribute("data-mode");
    try {
      window.localStorage.removeItem("labelverify:mode");
    } catch {
      // ignore
    }
  });

  afterEach(() => {
    document.documentElement.removeAttribute("data-mode");
  });

  it("renders two pressed-state buttons grouped under role=group", () => {
    render(<ModeToggle />);
    const group = screen.getByRole("group", { name: /view mode/i });
    expect(group).toBeInTheDocument();
    expect(screen.getByRole("button", { name: /^Simple$/ })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: /^Detailed$/ })).toBeInTheDocument();
  });

  it("clicking Simple sets data-mode=simple and persists to localStorage", () => {
    render(<ModeToggle />);
    fireEvent.click(screen.getByRole("button", { name: /^Simple$/ }));
    expect(document.documentElement.getAttribute("data-mode")).toBe("simple");
    expect(window.localStorage.getItem("labelverify:mode")).toBe("simple");
    // aria-pressed reflects the active button.
    expect(screen.getByRole("button", { name: /^Simple$/ })).toHaveAttribute(
      "aria-pressed",
      "true",
    );
    expect(screen.getByRole("button", { name: /^Detailed$/ })).toHaveAttribute(
      "aria-pressed",
      "false",
    );
  });

  it("clicking Detailed flips the mode + persists", () => {
    render(<ModeToggle />);
    fireEvent.click(screen.getByRole("button", { name: /^Detailed$/ }));
    expect(document.documentElement.getAttribute("data-mode")).toBe("detailed");
    expect(window.localStorage.getItem("labelverify:mode")).toBe("detailed");
    expect(screen.getByRole("button", { name: /^Detailed$/ })).toHaveAttribute(
      "aria-pressed",
      "true",
    );
  });

  it("readViewMode falls back to 'simple' when no attribute or storage is set", () => {
    expect(readViewMode()).toBe("simple");
  });

  it("readViewMode reads the document attribute when set", () => {
    document.documentElement.setAttribute("data-mode", "detailed");
    expect(readViewMode()).toBe("detailed");
  });

  it("each toggle button has a descriptive title for non-technical users", () => {
    render(<ModeToggle />);
    expect(
      screen.getByRole("button", { name: /^Simple$/ }),
    ).toHaveAttribute("title", expect.stringMatching(/recommended for first-time use/i));
    expect(
      screen.getByRole("button", { name: /^Detailed$/ }),
    ).toHaveAttribute("title", expect.stringMatching(/recommended for operators/i));
  });
});
