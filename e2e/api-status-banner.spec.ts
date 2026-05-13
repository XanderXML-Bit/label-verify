import { test, expect } from "@playwright/test";

// ─── E2E: ApiStatusBanner ──────────────────────────────────────────────────
//
// The page-load ApiStatusBanner surfaces /api/health "notes" (e.g.
// "GOOGLE_API_KEY missing") so the reviewer sees an actionable message
// instead of getting a verify 500 cold. This test mocks /api/health to
// return a configuration warning and verifies the banner appears.

test("Missing-key /api/health note surfaces in the page-load banner", async ({
  page,
}) => {
  await page.route("**/api/health", (route) =>
    route.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify({
        ok: true,
        ready: false,
        service: "label-verify",
        notes: [
          "The verification service is missing a required API key. The operator needs to add it before single-image verifies will run.",
        ],
      }),
    }),
  );
  await page.goto("/");
  await expect(
    page.getByText(/missing a required API key|verification service/i),
  ).toBeVisible({ timeout: 10_000 });
});

test("Healthy /api/health → no banner shown", async ({ page }) => {
  await page.route("**/api/health", (route) =>
    route.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify({
        ok: true,
        ready: true,
        service: "label-verify",
        notes: [],
      }),
    }),
  );
  await page.goto("/");
  // The banner's distinctive copy must NOT appear on a healthy load.
  await page.waitForLoadState("networkidle");
  await expect(
    page.getByText(/missing a required API key/i),
  ).toHaveCount(0);
});
