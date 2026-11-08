// WCAG 2.5.3 Label in Name regressions for the Detailed-mode sample
// buttons and the iOS-only document chooser item.
//
// axe-core's `label-content-name-mismatch` rule flagged the sample
// buttons because their `aria-label` ("Try the pass sample") did not
// contain the visible label ("Expected: PASS · PASS sample · …"). The
// iOS document menuitem had the same class of mismatch ("Choose a PDF
// or other application document" vs visible "Application document").
// Both now take their accessible name from their visible content, so
// a speech-input user can say what they see.

import { afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { cleanup, render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { SampleAffordance } from "@/app/components/SampleAffordance";
import { SAMPLES } from "@/lib/samples";

/** The accessible name testing-library computes for `el` (dom-accessibility-api). */
function accessibleName(el: HTMLElement, role: string): string {
  let captured: string | undefined;
  within(el.parentElement ?? document.body).getAllByRole(role, {
    name: (name, element) => {
      if (element === el) captured = name;
      return element === el;
    },
  });
  if (captured === undefined) throw new Error("element not found by role");
  return captured;
}

/** Text a sighted user sees: skips `.sr-only` and `aria-hidden` subtrees. */
function visibleText(el: Element): string {
  let out = "";
  for (const node of Array.from(el.childNodes)) {
    if (node.nodeType === Node.TEXT_NODE) {
      out += node.textContent ?? "";
    } else if (node instanceof Element) {
      if (node.classList.contains("sr-only")) continue;
      if (node.getAttribute("aria-hidden") !== null && node.getAttribute("aria-hidden") !== "false") continue;
      out += ` ${visibleText(node)} `;
    }
  }
  return out;
}

/** axe-style comparison: case-, whitespace- and punctuation-insensitive. */
function normalize(s: string): string {
  return s
    .toLowerCase()
    .replace(/[^\p{L}\p{N}\s]/gu, " ")
    .replace(/\s+/g, " ")
    .trim();
}

function sampleButtons(): HTMLButtonElement[] {
  return SAMPLES.map((s) => {
    const labelSpan = screen.getByText(s.label);
    const btn = labelSpan.closest("button");
    if (!btn) throw new Error(`no button for ${s.id}`);
    return btn as HTMLButtonElement;
  });
}

describe("SampleAffordance — label in name", () => {
  afterEach(() => {
    cleanup();
    vi.unstubAllGlobals();
  });

  it("each sample button's accessible name contains its full visible text", () => {
    vi.stubGlobal("fetch", vi.fn());
    render(<SampleAffordance onPick={() => {}} />);
    const buttons = sampleButtons();
    expect(buttons).toHaveLength(3);
    SAMPLES.forEach((s, i) => {
      const btn = buttons[i]!;
      const name = accessibleName(btn, "button");
      const visible = visibleText(btn);
      expect(normalize(visible).length).toBeGreaterThan(0);
      expect(normalize(name)).toContain(normalize(visible));
      // The verdict-specific visible label is spoken, in order.
      expect(name).toContain(s.label);
      expect(normalize(name).startsWith(normalize(`Expected: ${s.expectedVerdict} ${s.label}`))).toBe(true);
      // Reachable by the words on screen.
      expect(screen.getByRole("button", { name: new RegExp(s.label) })).toBe(btn);
    });
    // The three verdict labels are each present exactly once.
    const names = buttons.map((b) => accessibleName(b, "button"));
    for (const label of ["PASS sample", "FAIL sample", "REVIEW sample"]) {
      expect(names.filter((n) => n.includes(label))).toHaveLength(1);
    }
  });

  it("aria-busy reflects the pending sample without changing the name to non-visible text", async () => {
    let release: (() => void) | undefined;
    const blob = new Blob([new Uint8Array([0, 1, 2, 3])], { type: "image/png" });
    vi.stubGlobal(
      "fetch",
      vi.fn(
        () =>
          new Promise<Response>((resolve) => {
            release = () => resolve({ ok: true, blob: async () => blob } as unknown as Response);
          }),
      ),
    );
    const user = userEvent.setup();
    const onPick = vi.fn();
    render(<SampleAffordance onPick={onPick} />);
    const [passBtn, failBtn, reviewBtn] = sampleButtons();
    for (const b of [passBtn!, failBtn!, reviewBtn!]) {
      expect(b.getAttribute("aria-busy")).toBeNull();
    }

    await user.click(passBtn!);
    await waitFor(() => expect(passBtn!.getAttribute("aria-busy")).toBe("true"));
    expect(failBtn!.getAttribute("aria-busy")).toBeNull();
    expect(reviewBtn!.getAttribute("aria-busy")).toBeNull();
    const pendingName = accessibleName(passBtn!, "button");
    expect(pendingName).toContain("PASS sample");
    expect(normalize(pendingName)).toContain(normalize(visibleText(passBtn!)));
    expect(pendingName).not.toMatch(/loading/i);

    release?.();
    await waitFor(() => expect(onPick).toHaveBeenCalledTimes(1));
    await waitFor(() => expect(passBtn!.getAttribute("aria-busy")).toBeNull());
  });
});

// ---------------------------------------------------------------------------
// iOS document chooser item
// ---------------------------------------------------------------------------

beforeAll(() => {
  if (typeof (globalThis as { DataTransferItem?: unknown }).DataTransferItem === "undefined") {
    class DataTransferItemStub {
      webkitGetAsEntry(): null {
        return null;
      }
    }
    Object.defineProperty(globalThis, "DataTransferItem", {
      value: DataTransferItemStub,
      configurable: true,
    });
  }
});

function stubIosNavigator(): () => void {
  const original = globalThis.navigator;
  Object.defineProperty(globalThis, "navigator", {
    value: {
      userAgent:
        "Mozilla/5.0 (iPhone; CPU iPhone OS 17_4 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.4 Mobile/15E148 Safari/604.1",
      maxTouchPoints: 5,
    } as Navigator,
    configurable: true,
  });
  return () => {
    Object.defineProperty(globalThis, "navigator", { value: original, configurable: true });
  };
}

describe("UploadZone iOS chooser — document item label in name", () => {
  afterEach(() => {
    cleanup();
  });

  it.each([
    { mode: "replace" as const, label: "Application document" },
    { mode: "append" as const, label: "Add document" },
  ])("$mode mode: accessible name starts with the visible label '$label'", async ({ mode, label }) => {
    const restore = stubIosNavigator();
    try {
      const user = userEvent.setup();
      const { UploadZone } = await import("@/app/components/UploadZone");
      const { container } = render(<UploadZone onFiles={() => undefined} mode={mode} />);
      // The trigger is the menu-popup button (only advertised on iOS).
      const trigger = await waitFor(() => {
        const t = container.querySelector<HTMLButtonElement>('button[aria-haspopup="menu"]');
        if (!t) throw new Error("iOS trigger not rendered yet");
        return t;
      });
      await user.click(trigger);
      const menu = await screen.findByRole("menu");
      const docItem = within(menu)
        .getAllByRole("menuitem")
        .find((el) => el.textContent?.includes(label));
      expect(docItem).toBeDefined();
      const name = accessibleName(docItem!, "menuitem");
      const visible = visibleText(docItem!);
      expect(normalize(name).startsWith(normalize(label))).toBe(true);
      expect(normalize(name)).toContain(normalize(visible));
      expect(name).toContain("(PDF, JSON, CSV, MD, TXT, DOCX)");
      // The aria-hidden emoji is not part of the name.
      expect(name).not.toContain("📄");
    } finally {
      restore();
    }
  });
});
