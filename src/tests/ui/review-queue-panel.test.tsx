import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { ReviewQueuePanel } from "@/app/components/ReviewQueuePanel";

describe("ReviewQueuePanel", () => {
  beforeEach(() => {
    window.sessionStorage.clear();
  });
  afterEach(() => {
    window.sessionStorage.clear();
  });

  it("renders the empty state and an Open queue button when no token is stashed", () => {
    render(<ReviewQueuePanel fetchFn={vi.fn()} />);
    expect(screen.getByRole("heading", { name: /human review queue/i })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: /open queue/i })).toBeInTheDocument();
  });

  it("clicking Open queue surfaces an inline token input — not window.prompt", async () => {
    // Make sure the prompt fallback never fires. If the component
    // regresses to window.prompt, this spy catches it.
    const promptSpy = vi.spyOn(window, "prompt").mockReturnValue(null);
    render(<ReviewQueuePanel fetchFn={vi.fn()} />);
    await userEvent.click(screen.getByRole("button", { name: /open queue/i }));
    await waitFor(() =>
      expect(screen.getByPlaceholderText(/DEBUG_TOKEN/)).toBeInTheDocument(),
    );
    expect(promptSpy).not.toHaveBeenCalled();
    promptSpy.mockRestore();
  });
});
