import { test, expect } from "@playwright/test";

// ─── E2E: idle screen + sample affordance ──────────────────────────────────
//
// Covers the two-affordance idle screen and the "Try the pass sample"
// happy path through the verification pipeline. If this fails, the demo
// is broken in a way every reviewer will see on first contact.

test.describe("Idle screen", () => {
  test("loads with all the canonical affordances visible", async ({ page }) => {
    await page.goto("/");
    await expect(
      page.getByRole("heading", { name: /Verify a label against application data/i }),
    ).toBeVisible();
    await expect(
      page.getByRole("region", { name: /Label upload area/i }),
    ).toBeVisible();
    await expect(page.getByRole("region", { name: /Try a sample/i })).toBeVisible();
    await expect(page.getByText(/More options/i)).toBeVisible();
    await expect(page.getByText(/About this prototype/i)).toBeVisible();
  });

  test("dark-mode toggle flips the data-theme attribute", async ({ page }) => {
    await page.goto("/");
    const html = page.locator("html");
    const before = await html.getAttribute("data-theme");
    await page.getByRole("button", { name: /Toggle dark mode/i }).click();
    const after = await html.getAttribute("data-theme");
    expect(after).not.toBe(before);
    // And persists through a reload (per the localStorage contract).
    await page.reload();
    const persisted = await page.locator("html").getAttribute("data-theme");
    expect(persisted).toBe(after);
  });

  test("Human review queue surfaces on the idle screen", async ({ page }) => {
    // The Settings panel was retired (single production path now).
    // The review queue lives directly on the idle screen.
    await page.goto("/");
    await expect(
      page.getByRole("region", { name: /Human review queue/i }),
    ).toBeVisible();
  });
});

test.describe("Sample affordance", () => {
  // Each sample's expected verdict is asserted explicitly. A federal
  // reviewer's first interaction with the demo is to click each
  // sample and confirm the chip matches the button's "Expected: …"
  // label — this e2e suite enforces that contract against the live
  // deployment via .github/workflows/e2e-live.yml.

  test("PASS sample reaches a PASS verdict", async ({ page }) => {
    await page.goto("/");
    await page.getByRole("button", { name: /Try the pass sample/i }).click();
    await expect(
      page.getByRole("region", { name: /Verification result/i }),
    ).toBeVisible({ timeout: 30_000 });
    // The header chip is the canonical verdict location.
    const verdict = await page
      .locator("text=/^(PASS|FAIL|REVIEW)$/")
      .first()
      .innerText();
    expect(verdict).toBe("PASS");
  });

  test("FAIL sample reaches a FAIL verdict (title-case Gov-Warning prefix)", async ({
    page,
  }) => {
    await page.goto("/");
    await page.getByRole("button", { name: /Try the fail sample/i }).click();
    await expect(
      page.getByRole("region", { name: /Verification result/i }),
    ).toBeVisible({ timeout: 30_000 });
    const verdict = await page
      .locator("text=/^(PASS|FAIL|REVIEW)$/")
      .first()
      .innerText();
    expect(verdict).toBe("FAIL");
  });

  test("REVIEW sample reaches a REVIEW verdict (Lager vs Pilsner)", async ({
    page,
  }) => {
    await page.goto("/");
    await page.getByRole("button", { name: /Try the review sample/i }).click();
    await expect(
      page.getByRole("region", { name: /Verification result/i }),
    ).toBeVisible({ timeout: 30_000 });
    const verdict = await page
      .locator("text=/^(PASS|FAIL|REVIEW)$/")
      .first()
      .innerText();
    expect(verdict).toBe("REVIEW");
  });
});
