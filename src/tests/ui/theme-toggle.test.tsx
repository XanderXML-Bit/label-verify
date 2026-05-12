import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { ThemeToggle } from "@/app/components/ThemeToggle";

// ─── ThemeToggle ────────────────────────────────────────────────────────────
//
// Contract:
//   - Renders a button with aria-label="Toggle dark mode".
//   - aria-pressed mirrors the current theme — false in light, true in dark.
//   - Default (no stored value, no <html data-theme>): light.
//   - Click flips both the <html data-theme> attribute and localStorage.
//   - If <html data-theme="dark"> is set before mount (the pre-paint script's
//     job), the initial post-mount state reflects dark.

const STORAGE_KEY = "labelverify:theme";

describe("ThemeToggle", () => {
  beforeEach(() => {
    window.localStorage.clear();
    // Reset <html data-theme> between tests — jsdom keeps the document
    // alive across renders so a leftover attribute would leak.
    document.documentElement.removeAttribute("data-theme");
  });

  afterEach(() => {
    window.localStorage.clear();
    document.documentElement.removeAttribute("data-theme");
  });

  it("renders with the toggle aria-label and defaults to light (aria-pressed=false)", () => {
    render(<ThemeToggle />);
    const btn = screen.getByRole("button", { name: /toggle dark mode/i });
    expect(btn).toBeInTheDocument();
    expect(btn).toHaveAttribute("aria-pressed", "false");
  });

  it("clicking flips aria-pressed from false to true and back", async () => {
    const user = userEvent.setup();
    render(<ThemeToggle />);
    const btn = screen.getByRole("button", { name: /toggle dark mode/i });
    expect(btn).toHaveAttribute("aria-pressed", "false");
    await user.click(btn);
    expect(btn).toHaveAttribute("aria-pressed", "true");
    await user.click(btn);
    expect(btn).toHaveAttribute("aria-pressed", "false");
  });

  it("sets data-theme on <html> when toggled", async () => {
    const user = userEvent.setup();
    render(<ThemeToggle />);
    const btn = screen.getByRole("button", { name: /toggle dark mode/i });
    await user.click(btn);
    expect(document.documentElement.getAttribute("data-theme")).toBe("dark");
    await user.click(btn);
    expect(document.documentElement.getAttribute("data-theme")).toBe("light");
  });

  it("persists the chosen theme to localStorage[labelverify:theme]", async () => {
    const user = userEvent.setup();
    render(<ThemeToggle />);
    const btn = screen.getByRole("button", { name: /toggle dark mode/i });
    await user.click(btn);
    expect(window.localStorage.getItem(STORAGE_KEY)).toBe("dark");
    await user.click(btn);
    expect(window.localStorage.getItem(STORAGE_KEY)).toBe("light");
  });

  it("reads the existing <html data-theme=dark> attribute on mount and starts pressed", () => {
    // Simulate the pre-paint script having already run.
    document.documentElement.setAttribute("data-theme", "dark");
    render(<ThemeToggle />);
    const btn = screen.getByRole("button", { name: /toggle dark mode/i });
    // After the post-mount useEffect, the button reflects the document state.
    expect(btn).toHaveAttribute("aria-pressed", "true");
  });

  it("meets the 44 px touch-target floor", () => {
    render(<ThemeToggle />);
    const btn = screen.getByRole("button", { name: /toggle dark mode/i });
    // Tailwind's `min-h-[44px]` and `min-w-[44px]` are class-driven; we
    // assert their presence rather than relying on layout (jsdom does no
    // real CSS layout).
    expect(btn.className).toMatch(/min-h-\[44px\]/);
    expect(btn.className).toMatch(/min-w-\[44px\]/);
  });
});
