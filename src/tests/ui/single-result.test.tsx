import { describe, expect, it, vi } from "vitest";
import { render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { SingleResult } from "@/app/components/SingleResult";
import type { VerifyResponse } from "@/lib/types";
import type { FieldComparison } from "@/lib/matching";

// ─── Fixture helpers ───────────────────────────────────────────────────────
//
// Per-field FieldComparison fixtures. We build the minimum shape SingleResult
// reads (field, status, expected, actual, optional components) and cast the
// rest of the response.

function fc(
  field: string,
  status: FieldComparison["status"],
  expected: unknown,
  actual: unknown,
  components?: Record<string, FieldComparison["status"]>,
): FieldComparison {
  return {
    field,
    status,
    expected,
    actual,
    confidence: 0.9,
    ...(components ? { components } : {}),
  };
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
  };
}

function failingResponseWithProducerComponents(): VerifyResponse {
  const base = passingResponse();
  return {
    ...base,
    verdict: "fail",
    fields: {
      ...base.fields,
      producer: fc(
        "producer",
        "fail",
        { name: "Marrow & Bone", city: "Boise" },
        { name: "Marrow Bone", city: "Boyse" },
        { name: "pass", street: "fail", city: "fail" },
      ),
    },
    governmentWarning: {
      ...base.governmentWarning,
      status: "pass",
    },
  };
}

// ─── Tests ─────────────────────────────────────────────────────────────────

describe("SingleResult", () => {
  it("renders verdict, quality, and per-field rows for a pass response", () => {
    render(
      <SingleResult
        result={passingResponse()}
        imagePreviewUrl="blob:fake"
        onAnother={() => {}}
      />,
    );
    // PASS chips appear on the aggregate verdict, every passing field row,
    // and every passing government-warning subscore — there are many.
    expect(screen.getAllByLabelText("Verdict PASS").length).toBeGreaterThan(1);
    expect(screen.getByLabelText("Image quality Good")).toBeInTheDocument();
    // Each of the six declared fields gets a row labelled with its name.
    expect(screen.getByText("brand name")).toBeInTheDocument();
    expect(screen.getByText("class type")).toBeInTheDocument();
    expect(screen.getByText("abv percent")).toBeInTheDocument();
    expect(screen.getByText("net contents")).toBeInTheDocument();
    expect(screen.getByText("producer")).toBeInTheDocument();
    expect(screen.getByText("country of origin")).toBeInTheDocument();
    // Image preview alt text.
    expect(screen.getByAltText("Submitted label preview")).toBeInTheDocument();
  });

  it("renders the component-level breakdown for a fail response with producer components", () => {
    render(
      <SingleResult
        result={failingResponseWithProducerComponents()}
        imagePreviewUrl="blob:fake"
        onAnother={() => {}}
      />,
    );
    // Two FAIL chips are expected: the large aggregate one, plus a small
    // chip on the producer row itself.
    expect(screen.getAllByLabelText("Verdict FAIL")).toHaveLength(2);

    // The producer row should expose the per-component breakdown details.
    const summary = screen.getByText("Per-component breakdown");
    expect(summary).toBeInTheDocument();
    const details = summary.closest("details");
    expect(details).not.toBeNull();
    const list = within(details!).getByRole("list");
    expect(within(list).getByText(/name/i)).toBeInTheDocument();
    expect(within(list).getByText(/street/i)).toBeInTheDocument();
    expect(within(list).getByText(/city/i)).toBeInTheDocument();
  });

  it("calls onAnother when the 'Verify another label' button is clicked", async () => {
    const user = userEvent.setup();
    const onAnother = vi.fn();
    render(
      <SingleResult
        result={passingResponse()}
        imagePreviewUrl="blob:fake"
        onAnother={onAnother}
      />,
    );
    await user.click(screen.getByRole("button", { name: "Verify another label" }));
    expect(onAnother).toHaveBeenCalledTimes(1);
  });
});
