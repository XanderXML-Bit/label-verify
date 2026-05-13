import { test, expect } from "@playwright/test";
import { join } from "node:path";

// ─── E2E: DeclaredForm validation ──────────────────────────────────────────
//
// Covers user-facing form validation — the kind of regression that's
// embarrassing if it slips because every reviewer typing into the form
// will hit it on their first try. Component-level tests live in
// `src/tests/ui/declared-form.test.tsx`; this exists to prove the
// validation reaches the user through the full page flow.

const SAMPLE_LABEL = join(
  process.cwd(),
  "test-data-v2",
  "labels",
  "syn-beer-0001.png",
);

async function uploadLabel(page: Awaited<ReturnType<typeof test.use>> extends never ? never : Parameters<Parameters<typeof test>[1]>[0]["page"]): Promise<void> {
  await page.goto("/");
  await page.setInputFiles('input[type="file"]', SAMPLE_LABEL);
  await expect(
    page.getByText(/Application data \(optional\)/i),
  ).toBeVisible({ timeout: 10_000 });
}

test.describe("Form validation reaches the user via the page flow", () => {
  test("Submitting with empty brand surfaces an assertive error", async ({
    page,
  }) => {
    await uploadLabel(page);
    // Click Verify without filling any fields — brand_name is required.
    await page.getByRole("button", { name: /^Verify$/ }).click();
    // The form scrolls an assertive role="alert" into view containing
    // the validation summary.
    await expect(page.getByRole("alert").first()).toBeVisible({
      timeout: 5_000,
    });
    // The brand input should be aria-invalid.
    const brand = page.getByRole("textbox", { name: /Brand name/i });
    await expect(brand).toHaveAttribute("aria-invalid", "true");
  });

  test("ABV outside 0..100 is rejected before POST", async ({ page }) => {
    let postFired = false;
    await page.route("**/api/verify", (route) => {
      postFired = true;
      void route.fulfill({ status: 200, body: "{}" });
    });
    await uploadLabel(page);
    await page.getByRole("textbox", { name: /Brand name/i }).fill("Test");
    await page.getByRole("textbox", { name: /Class type/i }).fill("IPA");
    // Try an absurd ABV. The form should refuse to submit.
    await page.getByRole("spinbutton", { name: /ABV/i }).fill("250");
    await page.getByRole("button", { name: /^Verify$/ }).click();
    // Either the input is rejected via aria-invalid OR the form blocks
    // submission with an inline message. Either way no POST should fire.
    await page.waitForTimeout(500);
    expect(postFired).toBe(false);
  });

  test("Net contents value must be positive", async ({ page }) => {
    let postFired = false;
    await page.route("**/api/verify", (route) => {
      postFired = true;
      void route.fulfill({ status: 200, body: "{}" });
    });
    await uploadLabel(page);
    await page.getByRole("textbox", { name: /Brand name/i }).fill("Test");
    await page.getByRole("textbox", { name: /Class type/i }).fill("IPA");
    await page.getByRole("spinbutton", { name: /ABV/i }).fill("5");
    // Zero net contents — must reject.
    await page
      .getByRole("spinbutton", { name: /Net contents value/i })
      .fill("0");
    await page.getByRole("button", { name: /^Verify$/ }).click();
    await page.waitForTimeout(500);
    expect(postFired).toBe(false);
  });
});
