import { describe, expect, it } from "vitest";
import { render, screen } from "@testing-library/react";
import { VerdictChip, QualityChip } from "@/app/components/StatusChip";

describe("VerdictChip", () => {
  it("renders the PASS variant with check icon, word, and aria-label", () => {
    render(<VerdictChip verdict="pass" />);
    const chip = screen.getByLabelText("Verdict PASS");
    expect(chip).toBeInTheDocument();
    expect(chip).toHaveTextContent("✓");
    expect(chip).toHaveTextContent("PASS");
  });

  it("renders the FAIL variant with cross icon and word", () => {
    render(<VerdictChip verdict="fail" />);
    const chip = screen.getByLabelText("Verdict FAIL");
    expect(chip).toBeInTheDocument();
    expect(chip).toHaveTextContent("✗");
    expect(chip).toHaveTextContent("FAIL");
  });

  it("renders the REVIEW variant with warning icon and word", () => {
    render(<VerdictChip verdict="review" />);
    const chip = screen.getByLabelText("Verdict REVIEW");
    expect(chip).toBeInTheDocument();
    expect(chip).toHaveTextContent("⚠");
    expect(chip).toHaveTextContent("REVIEW");
  });

  it("applies size-specific sizing classes", () => {
    const { rerender } = render(<VerdictChip verdict="pass" size="sm" />);
    expect(screen.getByLabelText("Verdict PASS").className).toMatch(/text-xs/);
    rerender(<VerdictChip verdict="pass" size="lg" />);
    expect(screen.getByLabelText("Verdict PASS").className).toMatch(/text-base/);
  });
});

describe("QualityChip", () => {
  it("renders the good variant with filled dot and 'Good' label", () => {
    render(<QualityChip quality="good" />);
    const chip = screen.getByLabelText("Image quality Good");
    expect(chip).toBeInTheDocument();
    expect(chip).toHaveTextContent("●");
    expect(chip).toHaveTextContent("Good");
  });

  it("renders the low variant with hollow dot and 'Low' label", () => {
    render(<QualityChip quality="low" />);
    const chip = screen.getByLabelText("Image quality Low");
    expect(chip).toBeInTheDocument();
    expect(chip).toHaveTextContent("○");
    expect(chip).toHaveTextContent("Low");
  });

  it("renders the bad variant with 'Re-photograph' guidance label", () => {
    render(<QualityChip quality="bad" />);
    const chip = screen.getByLabelText("Image quality Re-photograph");
    expect(chip).toBeInTheDocument();
    expect(chip).toHaveTextContent("○");
    expect(chip).toHaveTextContent("Re-photograph");
  });
});
