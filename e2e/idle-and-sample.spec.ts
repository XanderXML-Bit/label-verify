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

  test("More options disclosure reveals settings + review queue", async ({
    page,
  }) => {
    await page.goto("/");
    await page.getByText(/More options/i).click();
    await expect(page.getByRole("region", { name: /Settings/i })).toBeVisible();
    await expect(
      page.getByRole("region", { name: /Human review queue/i }),
    ).toBeVisible();
  });
});

test.describe("Sample affordance", () => {
  test("PASS sample reaches a Verification result panel", async ({ page }) => {
    await page.goto("/");
    await page.getByRole("button", { name: /Try the pass sample/i }).click();
    // Vision call latency varies; allow generous wait.
    await expect(
      page.getByRole("region", { name: /Verification result/i }),
    ).toBeVisible({ timeout: 30_000 });
    // PASS sample should land on a non-FAIL verdict (PASS or REVIEW).
    const verdict = await page
      .locator("text=/^(PASS|FAIL|REVIEW)$/")
      .first()
      .innerText();
    expect(["PASS", "REVIEW"]).toContain(verdict);
  });
});
