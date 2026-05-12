import { describe, expect, it, vi } from "vitest";
import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { ExtractionOnlyResult } from "@/app/components/ExtractionOnlyResult";

function makeResult(): Parameters<typeof ExtractionOnlyResult>[0]["result"] {
  return {
    extracted: {
      brand_name: { value: "Stone's Throw", confidence: 0.9 },
      class_type: { value: "India Pale Ale", confidence: 0.9 },
      abv_percent: { value: 6.4, confidence: 0.9 },
      net_contents: { value: { value: 12, unit: "fl_oz" }, confidence: 0.9 },
      producer: { value: "Stone's Throw Brewing Co.", confidence: 0.9 },
      country_of_origin: { value: "USA", confidence: 0.9 },
      government_warning: {
        value: null,
        confidence: 0.9,
      } as unknown as never,
    } as unknown as Parameters<typeof ExtractionOnlyResult>[0]["result"]["extracted"],
    imageQuality: "good",
    governmentWarning: {
      status: "pass",
      confidence: 0.9,
      subscores: {
        text: { status: "pass", confidence: 0.9 },
        caps: { status: "pass", confidence: 0.9 },
        bold: { status: "pass", confidence: 0.9 },
        size: { status: "pass", confidence: 0.9 },
      },
    },
    timings: { preprocess: 1, ocr: 1, vision: 1, matching: 1, total: 100 },
    modelId: "gemini:gemini-3.1-flash-lite",
    modelVersion: "v1",
    modeUsed: "default",
    note: "Extraction-only result.",
  };
}

describe("ExtractionOnlyResult", () => {
  it("renders the not-a-verdict disclaimer and the extracted brand", () => {
    render(
      <ExtractionOnlyResult
        result={makeResult()}
        imagePreviewUrl=""
        onAnother={() => undefined}
      />,
    );
    expect(
      screen.getByText(/This is not a compliance verdict/i),
    ).toBeInTheDocument();
    expect(screen.getAllByText(/Stone's Throw/).length).toBeGreaterThan(0);
  });

  it("offers a 'Now compare against application data' button when the callback is provided", async () => {
    const onContinue = vi.fn();
    render(
      <ExtractionOnlyResult
        result={makeResult()}
        imagePreviewUrl=""
        onAnother={() => undefined}
        onContinueToVerification={onContinue}
      />,
    );
    const btn = screen.getByRole("button", {
      name: /Now compare against application data/i,
    });
    await userEvent.click(btn);
    expect(onContinue).toHaveBeenCalledTimes(1);
  });

  it("hides the compare button when the callback is omitted", () => {
    render(
      <ExtractionOnlyResult
        result={makeResult()}
        imagePreviewUrl=""
        onAnother={() => undefined}
      />,
    );
    expect(
      screen.queryByRole("button", {
        name: /Now compare against application data/i,
      }),
    ).toBeNull();
  });
});
