import { describe, expect, it, vi } from "vitest";
import { render, screen } from "@testing-library/react";
import { UploadZone } from "@/app/components/UploadZone";
import { DeclaredForm } from "@/app/components/DeclaredForm";
import { SampleAffordance } from "@/app/components/SampleAffordance";
import { SingleResult } from "@/app/components/SingleResult";
import { VerdictChip, QualityChip } from "@/app/components/StatusChip";
import type { VerifyResponse } from "@/lib/types";
import type { FieldComparison } from "@/lib/matching";

// ─── a11y smoke tests ──────────────────────────────────────────────────────
//
// A manual audit (no axe-core dep). For each component we render with
// realistic props and assert the structural a11y contract:
//   - every <button> has a non-empty accessible name (text or aria-label)
//   - every form input has an associated <label> or aria-label
//   - every interactive [role=button]/[role=region] has a label
//
// If axe-core ever lands, these can become a single `expect(await
// axe(container)).toHaveNoViolations()` call — same intent, fewer lines.

// Helpers --------------------------------------------------------------------

function accessibleName(el: Element): string {
  const aria = el.getAttribute("aria-label");
  if (aria && aria.trim()) return aria.trim();
  const labelledBy = el.getAttribute("aria-labelledby");
  if (labelledBy) {
    const label = el.ownerDocument.getElementById(labelledBy);
    if (label?.textContent?.trim()) return label.textContent.trim();
  }
  return el.textContent?.trim() ?? "";
}

function assertButtonsHaveNames(container: HTMLElement) {
  const buttons = container.querySelectorAll("button, [role='button']");
  for (const btn of Array.from(buttons)) {
    const name = accessibleName(btn);
    expect(
      name,
      `button missing accessible name: ${btn.outerHTML.slice(0, 100)}`,
    ).not.toBe("");
  }
}

function assertInputsHaveLabels(container: HTMLElement) {
  const inputs = container.querySelectorAll("input, select, textarea");
  for (const input of Array.from(inputs)) {
    if (input.getAttribute("type") === "hidden") continue;
    const id = input.getAttribute("id");
    const aria = input.getAttribute("aria-label");
    const labelledBy = input.getAttribute("aria-labelledby");
    let labeled = Boolean(aria?.trim()) || Boolean(labelledBy?.trim());
    if (!labeled && id) {
      labeled = Boolean(container.querySelector(`label[for="${id}"]`));
    }
    if (!labeled) {
      // Wrapped <label><input/></label> pattern.
      labeled = input.closest("label") !== null;
    }
    expect(
      labeled,
      `input missing a label: ${input.outerHTML.slice(0, 100)}`,
    ).toBe(true);
  }
}

// Fixtures ------------------------------------------------------------------

function fc(
  field: string,
  status: FieldComparison["status"],
  expected: unknown,
  actual: unknown,
): FieldComparison {
  return { field, status, expected, actual, confidence: 0.9 };
}

function passingResponse(): VerifyResponse {
  return {
    verdict: "pass",
    imageQuality: "good",
    fields: {
      brand_name: fc("brand_name", "pass", "Bluerose", "Bluerose"),
      class_type: fc("class_type", "pass", "Pale Ale", "Pale Ale"),
      abv_percent: fc("abv_percent", "pass", 6.0, 6.0),
      net_contents: fc(
        "net_contents",
        "pass",
        { value: 200, unit: "ml" },
        { value: 200, unit: "ml" },
      ),
      producer: fc("producer", "pass", "Bluerose Beverage Co.", "Bluerose Beverage Co."),
      country_of_origin: fc("country_of_origin", "pass", "USA", "USA"),
    },
    governmentWarning: {
      status: "pass",
      confidence: 0.95,
      subscores: {
        text: { status: "pass", confidence: 0.99 },
        caps: { status: "pass", confidence: 0.99 },
        bold: { status: "pass", confidence: 0.95 },
        size: { status: "pass", confidence: 0.95 },
      },
    },
    extracted: {} as VerifyResponse["extracted"],
    timings: { preprocess: 100, ocr: null, vision: 1200, matching: 50, total: 2300 },
    modelId: "mock:test",
    modelVersion: "mock-v1",
    modeUsed: "default",
    requiresHumanReview: false,
    reviewReasons: [],
  };
}

// Tests ---------------------------------------------------------------------

describe("a11y — UploadZone", () => {
  it("every button has an accessible name and the dropzone is labelled", () => {
    const { container } = render(<UploadZone onFiles={() => {}} />);
    assertButtonsHaveNames(container);
    const dropzone = container.querySelector('[role="button"]');
    expect(dropzone).not.toBeNull();
    expect(accessibleName(dropzone!)).toMatch(/upload|drag|drop/i);
  });

  it("exposes a polite live region for file announcements", () => {
    const { container } = render(<UploadZone onFiles={() => {}} />);
    const live = container.querySelector('[aria-live="polite"]');
    expect(live).not.toBeNull();
  });
});

describe("a11y — DeclaredForm", () => {
  it("every input has a label and the submit button is named", () => {
    const { container } = render(<DeclaredForm onSubmit={() => {}} />);
    assertInputsHaveLabels(container);
    assertButtonsHaveNames(container);
  });

  it("validation errors render as an assertive alert with a heading", async () => {
    const { container } = render(<DeclaredForm onSubmit={() => {}} />);
    const submit = screen.getByRole("button", { name: "Verify" });
    submit.click();
    const alert = await screen.findByRole("alert");
    expect(alert).toHaveAttribute("aria-live", "assertive");
    // A heading anchors the error region so screen-reader users orient
    // before hearing the bullet list.
    expect(container.querySelector("[role='alert'] h3")).not.toBeNull();
  });
});

describe("a11y — SampleAffordance", () => {
  it("every sample button has a descriptive aria-label", () => {
    // Stub fetch so the activate() promise doesn't blow up unrelated state.
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => ({ ok: true, blob: async () => new Blob([]) }) as unknown as Response),
    );
    const { container } = render(<SampleAffordance onPick={() => {}} />);
    assertButtonsHaveNames(container);
    vi.unstubAllGlobals();
  });
});

describe("a11y — SingleResult", () => {
  it("every button has an accessible name and chips are aria-labelled", () => {
    const { container } = render(
      <SingleResult
        result={passingResponse()}
        imagePreviewUrl="blob:fake"
        onAnother={() => {}}
      />,
    );
    assertButtonsHaveNames(container);
    // VerdictChip + QualityChip rely on aria-label; verify at least one of
    // each is reachable.
    expect(screen.getAllByLabelText(/^Verdict /).length).toBeGreaterThan(0);
    expect(screen.getAllByLabelText(/^Image quality /).length).toBeGreaterThan(0);
  });
});

describe("a11y — StatusChip", () => {
  it("VerdictChip exposes both icon and word so color is never the only cue", () => {
    const { container } = render(<VerdictChip verdict="fail" />);
    const chip = container.firstElementChild!;
    expect(accessibleName(chip)).toBe("Verdict FAIL");
    // Word visible.
    expect(chip.textContent).toContain("FAIL");
  });

  it("QualityChip exposes its label including the 'Re-photograph' guidance", () => {
    const { container } = render(<QualityChip quality="bad" />);
    const chip = container.firstElementChild!;
    expect(accessibleName(chip)).toBe("Image quality Re-photograph");
  });
});
