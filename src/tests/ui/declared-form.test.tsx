import { describe, expect, it, vi } from "vitest";
import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { DeclaredForm } from "@/app/components/DeclaredForm";
import type { DeclaredFields } from "@/lib/types";

describe("DeclaredForm", () => {
  it("renders all eight declared-field controls", () => {
    render(<DeclaredForm onSubmit={() => {}} />);
    // Eight fields per UI-SPEC: brand, class/type, category, ABV, nc value,
    // nc unit, producer/address, country of origin.
    expect(screen.getByText("Brand name")).toBeInTheDocument();
    expect(screen.getByText("Class / type")).toBeInTheDocument();
    expect(screen.getByText("Category")).toBeInTheDocument();
    expect(screen.getByText("ABV (%)")).toBeInTheDocument();
    expect(screen.getByText("Net contents value")).toBeInTheDocument();
    expect(screen.getByText("Net contents unit")).toBeInTheDocument();
    expect(screen.getByText("Producer / address")).toBeInTheDocument();
    expect(screen.getByText("Country of origin")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Verify" })).toBeInTheDocument();
  });

  it("shows an error message when submitting with an empty brand", async () => {
    const user = userEvent.setup();
    const onSubmit = vi.fn();
    render(<DeclaredForm onSubmit={onSubmit} />);

    // Fill the *other* required fields so we isolate the brand error.
    await user.type(screen.getByText("Class / type").parentElement!.querySelector("input")!, "Pale Ale");
    await user.type(screen.getByText("ABV (%)").parentElement!.querySelector("input")!, "5");
    await user.type(screen.getByText("Net contents value").parentElement!.querySelector("input")!, "12");
    await user.click(screen.getByRole("button", { name: "Verify" }));

    const alert = await screen.findByRole("alert");
    expect(alert).toHaveTextContent("Brand name is required.");
    expect(onSubmit).not.toHaveBeenCalled();
  });

  it("submits a structured payload when all required fields are valid", async () => {
    const user = userEvent.setup();
    const onSubmit = vi.fn();
    render(<DeclaredForm onSubmit={onSubmit} />);

    await user.type(screen.getByText("Brand name").parentElement!.querySelector("input")!, "Bluerose");
    await user.type(screen.getByText("Class / type").parentElement!.querySelector("input")!, "Pale Ale");
    await user.type(screen.getByText("ABV (%)").parentElement!.querySelector("input")!, "6");
    await user.type(screen.getByText("Net contents value").parentElement!.querySelector("input")!, "200");
    // Country defaults to "USA"; producer is optional.
    await user.click(screen.getByRole("button", { name: "Verify" }));

    expect(onSubmit).toHaveBeenCalledTimes(1);
    const arg = onSubmit.mock.calls[0]?.[0] as DeclaredFields;
    expect(arg.brand_name).toBe("Bluerose");
    expect(arg.class_type).toBe("Pale Ale");
    expect(arg.class_category).toBe("beer");
    expect(arg.abv_percent).toBe(6);
    expect(arg.net_contents).toEqual({ value: 200, unit: "fl_oz" });
    expect(arg.producer).toBe("");
    expect(arg.country_of_origin).toBe("USA");
  });

  it("disables every input and the submit button when disabled is true", () => {
    const { container } = render(<DeclaredForm onSubmit={() => {}} disabled />);
    const controls = container.querySelectorAll<HTMLElement>(
      "input, select, textarea, button",
    );
    expect(controls.length).toBeGreaterThan(0);
    for (const c of controls) {
      expect(c).toBeDisabled();
    }
  });
});
