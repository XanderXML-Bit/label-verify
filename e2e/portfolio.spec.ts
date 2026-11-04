import { expect, test } from "@playwright/test";

for (const viewport of [{ width: 390, height: 844 }, { width: 1440, height: 900 }]) {
  test(`brand and privacy at ${viewport.width}px`, async ({ page }) => {
    await page.setViewportSize(viewport);
    await page.goto("/");
    await expect(page.locator('link[rel="canonical"]')).toHaveAttribute(
      "href",
      "https://label-verify-six.vercel.app",
    );
    await expect(page.locator('meta[property="og:image"]')).toHaveAttribute(
      "content",
      "https://label-verify-six.vercel.app/og-image.png",
    );
    await expect(page.locator('meta[name="twitter:card"]')).toHaveAttribute(
      "content",
      "summary_large_image",
    );
    await expect(page.locator('a[rel="author"]')).toHaveText("Xander M. Lopez");
    await page.getByRole("link", { name: "Privacy", exact: true }).click();
    await expect(page.getByRole("heading", { name: "Privacy", exact: true })).toBeVisible();
    await expect(page.getByText(/Google Gemini/)).toBeVisible();
    await expect(page.getByText(/up to 20 records/)).toBeVisible();
    await expect(page.locator('link[rel="canonical"]')).toHaveAttribute(
      "href",
      "https://label-verify-six.vercel.app/privacy",
    );
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
  });
}

test("unknown paths return a styled 404", async ({ page }) => {
  const response = await page.goto("/this-does-not-exist");
  expect(response?.status()).toBe(404);
  await expect(page.getByRole("heading", { name: "This page does not exist" })).toBeVisible();
  await page.getByRole("link", { name: "Go to the verifier" }).click();
  await expect(page.getByRole("heading", { name: "Verify a label against application data" })).toBeVisible();
});
