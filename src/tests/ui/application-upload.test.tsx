import { describe, expect, it, vi } from "vitest";
import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { ApplicationUpload } from "@/app/components/ApplicationUpload";

function hiddenInput(container: HTMLElement): HTMLInputElement {
  const input = container.querySelector<HTMLInputElement>('input[type="file"]');
  if (!input) throw new Error("file input not found");
  return input;
}

describe("ApplicationUpload", () => {
  it("renders the section heading and the file-picker label", () => {
    render(<ApplicationUpload onParsed={() => undefined} />);
    expect(
      screen.getByRole("heading", { name: /application data/i }),
    ).toBeInTheDocument();
    expect(screen.getByText(/Choose file/i)).toBeInTheDocument();
  });

  it("rejects HEIC uploads with a friendly inline error and does not POST", async () => {
    const onParsed = vi.fn();
    const fetchSpy = vi.spyOn(globalThis, "fetch");
    const { container } = render(<ApplicationUpload onParsed={onParsed} />);
    const input = hiddenInput(container);
    const file = new File(["…"], "form.heic", { type: "image/heic" });
    // applyAccept: false — we WANT to simulate a user who somehow bypasses
    // the `accept` filter (drag-and-drop, OS-specific picker quirks).
    // The component itself must reject HEIC even if it slips past `accept`.
    await userEvent.upload(input, file, { applyAccept: false });
    expect(onParsed).not.toHaveBeenCalled();
    expect(fetchSpy).not.toHaveBeenCalled();
    await waitFor(() =>
      expect(
        screen.getByText(/HEIC\/HEIF images aren't supported/i),
      ).toBeInTheDocument(),
    );
    fetchSpy.mockRestore();
  });
});
