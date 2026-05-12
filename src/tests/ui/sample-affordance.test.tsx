import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { SampleAffordance } from "@/app/components/SampleAffordance";
import { SAMPLES } from "@/lib/samples";

describe("SampleAffordance", () => {
  beforeEach(() => {
    // Stub fetch to return a 1x1 PNG-ish blob. The component only cares
    // that it gets a Blob it can wrap in a File — the bytes are opaque.
    const blob = new Blob([new Uint8Array([0, 1, 2, 3])], { type: "image/png" });
    vi.stubGlobal(
      "fetch",
      vi.fn(async () =>
        ({
          ok: true,
          blob: async () => blob,
        }) as unknown as Response,
      ),
    );
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("renders one button per sample with the expected-verdict label", () => {
    render(<SampleAffordance onPick={() => {}} />);
    for (const s of SAMPLES) {
      const btn = screen.getByRole("button", { name: `Try the ${s.id} sample` });
      expect(btn).toBeInTheDocument();
      expect(btn).toHaveTextContent(`Expected: ${s.expectedVerdict.toUpperCase()}`);
    }
    expect(SAMPLES).toHaveLength(3);
  });

  it("clicking a sample fetches the image and calls onPick with the sample + a File", async () => {
    const user = userEvent.setup();
    const onPick = vi.fn();
    render(<SampleAffordance onPick={onPick} />);

    const passSample = SAMPLES.find((s) => s.id === "pass")!;
    await user.click(screen.getByRole("button", { name: "Try the pass sample" }));

    expect(fetch).toHaveBeenCalledWith(passSample.imageUrl);
    expect(onPick).toHaveBeenCalledTimes(1);
    const [sampleArg, fileArg] = onPick.mock.calls[0] as [unknown, File];
    expect(sampleArg).toBe(passSample);
    expect(fileArg).toBeInstanceOf(File);
    expect(fileArg.name).toBe("pass.png");
    expect(fileArg.type).toBe("image/png");
  });

  it("does not fetch or call onPick when disabled", async () => {
    const user = userEvent.setup();
    const onPick = vi.fn();
    render(<SampleAffordance onPick={onPick} disabled />);
    const btn = screen.getByRole("button", { name: "Try the pass sample" });
    expect(btn).toBeDisabled();
    // Clicking a disabled button is a no-op in the DOM, but verify the
    // guard inside `activate` would also short-circuit the fetch.
    await user.click(btn);
    expect(fetch).not.toHaveBeenCalled();
    expect(onPick).not.toHaveBeenCalled();
  });
});
