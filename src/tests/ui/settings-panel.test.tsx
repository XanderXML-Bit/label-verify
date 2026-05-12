import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { render, screen, renderHook, act } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { useState } from "react";
import {
  SettingsPanel,
  useModelMode,
} from "@/app/components/SettingsPanel";
import { MODES, type ModelModeId } from "@/lib/model-modes";

// ─── SettingsPanel ──────────────────────────────────────────────────────────
//
// Tests pin the UX surface: 5 radio buttons (one per mode), collapsed by
// default, click toggles, localStorage persistence via the `useModelMode`
// hook. They do not mock the catalogue — we deliberately render against
// the real MODES so a future renaming surfaces here.

function Harness({ initial = "default" }: { initial?: ModelModeId }) {
  const [modeId, setModeId] = useState<ModelModeId>(initial);
  return (
    <SettingsPanel modeId={modeId} onModeChange={(id) => setModeId(id)} />
  );
}

describe("SettingsPanel", () => {
  beforeEach(() => {
    window.localStorage.clear();
  });
  afterEach(() => {
    window.localStorage.clear();
  });

  it("is collapsed by default — no radio buttons visible", () => {
    render(<Harness />);
    // The toggle says "Open settings" (collapsed copy).
    expect(
      screen.getByRole("button", { name: /open settings/i }),
    ).toBeInTheDocument();
    // No radiogroup before expanding.
    expect(screen.queryByRole("radiogroup")).not.toBeInTheDocument();
  });

  it("shows the current mode label and description inline when collapsed", () => {
    render(<Harness />);
    // "Default" mode is selected, so its label appears in the summary.
    expect(screen.getByText(/Model mode:/i)).toBeInTheDocument();
    expect(screen.getByText("Default")).toBeInTheDocument();
  });

  it("expanding reveals one radio button per mode (5 total)", async () => {
    const user = userEvent.setup();
    render(<Harness />);
    await user.click(screen.getByRole("button", { name: /open settings/i }));
    const radios = screen.getAllByRole("radio");
    expect(radios).toHaveLength(MODES.length);
    expect(MODES).toHaveLength(5);
    // Each mode's value attribute on its radio input — unique per mode.
    const values = radios.map((r) => (r as HTMLInputElement).value).sort();
    expect(values).toEqual(MODES.map((m) => m.id).slice().sort());
    // Each mode's description appears next to its radio.
    for (const m of MODES) {
      expect(screen.getByText(m.description)).toBeInTheDocument();
    }
  });

  it("expand button toggles its label and aria-expanded", async () => {
    const user = userEvent.setup();
    render(<Harness />);
    const btn = screen.getByRole("button", { name: /open settings/i });
    expect(btn).toHaveAttribute("aria-expanded", "false");
    await user.click(btn);
    const closeBtn = screen.getByRole("button", { name: /close settings/i });
    expect(closeBtn).toHaveAttribute("aria-expanded", "true");
    await user.click(closeBtn);
    expect(
      screen.getByRole("button", { name: /open settings/i }),
    ).toHaveAttribute("aria-expanded", "false");
  });

  it("clicking a radio fires onModeChange with that mode's id", async () => {
    const user = userEvent.setup();
    const onChange = vi.fn();
    render(<SettingsPanel modeId="default" onModeChange={onChange} />);
    await user.click(screen.getByRole("button", { name: /open settings/i }));
    const smart = MODES.find((m) => m.id === "smart")!;
    // The radio is wrapped in a label that contains the mode label text;
    // click that label to flip the radio (DOM event bubbles to the input).
    await user.click(screen.getByText(smart.label));
    expect(onChange).toHaveBeenCalledWith("smart");
  });
});

describe("useModelMode", () => {
  beforeEach(() => {
    window.localStorage.clear();
  });
  afterEach(() => {
    window.localStorage.clear();
  });

  it("defaults to 'default' when localStorage is empty", () => {
    const { result } = renderHook(() => useModelMode());
    expect(result.current.modeId).toBe("default");
  });

  it("writes the chosen id to localStorage[labelverify:mode]", () => {
    const { result } = renderHook(() => useModelMode());
    act(() => {
      result.current.setModeId("smart");
    });
    expect(window.localStorage.getItem("labelverify:mode")).toBe("smart");
    expect(result.current.modeId).toBe("smart");
  });

  it("hydrates from a previously stored value on mount", () => {
    window.localStorage.setItem("labelverify:mode", "balanced");
    const { result } = renderHook(() => useModelMode());
    // After the post-mount effect, modeId should reflect the stored value.
    expect(result.current.modeId).toBe("balanced");
  });

  it("ignores an unknown stored value and stays on the default", () => {
    window.localStorage.setItem("labelverify:mode", "no-such-mode");
    const { result } = renderHook(() => useModelMode());
    expect(result.current.modeId).toBe("default");
  });
});
