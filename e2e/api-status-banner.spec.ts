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
  // Wave-35o: the banner renders the note inside a `<li>` nested in a
  // `<div role="alert">` — Playwright's getByText with an OR-regex
  // matched BOTH the wrapper div and the inner li (each containing
  // the same substring), tripping strict-mode. Scope the lookup to
  // the `<li>` directly via the alert role + then a per-note query.
  const alert = page.getByRole("alert").filter({
    hasText: /missing a required API key/i,
  });
  await expect(alert).toBeVisible({ timeout: 10_000 });
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
  // Wave-35o: drop the previous `waitForLoadState("networkidle")` —
  // it hung past the test timeout on the live deployment because
  // `/api/warmup` keeps a slow connection alive while Tesseract's
  // WASM init resolves (~3–5 s after page load). The component-
  // under-test renders the banner from the `/api/health` payload
  // (mocked above) inside a `useEffect` that fires on mount, so
  // waiting for that effect to commit + then asserting the banner
  // is *not* in the DOM is the right shape.
  await expect(
    page.getByRole("heading", { name: /Verify a label against application data/i }),
  ).toBeVisible({ timeout: 10_000 });
  await expect(
    page.getByText(/missing a required API key/i),
  ).toHaveCount(0);
});
