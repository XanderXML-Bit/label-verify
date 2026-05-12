import { defineConfig, devices } from "@playwright/test";

// ─── Playwright config ─────────────────────────────────────────────────────
//
// Browser-driven E2E tests live in `e2e/`. They exercise the running
// dev server through real user journeys — drop a label image, fill the
// form, hit Verify, see a result.
//
// We do NOT auto-install browsers in CI. The intended workflow is:
//   npx playwright install chromium        # once
//   npm run dev   &                        # background
//   npm run test:e2e                       # runs this config
//
// Unit / API tests stay in `src/tests/` and run with vitest.

export default defineConfig({
  testDir: "./e2e",
  timeout: 60_000,
  expect: { timeout: 10_000 },
  // No parallel — the test suite hits the dev server's vision endpoint
  // and we don't want to race the upstream API rate limit.
  fullyParallel: false,
  workers: 1,
  retries: 1,
  reporter: [["list"], ["html", { open: "never" }]],
  use: {
    baseURL: process.env.E2E_BASE_URL ?? "http://localhost:3100",
    trace: "retain-on-failure",
    screenshot: "only-on-failure",
    video: "retain-on-failure",
  },
  projects: [
    {
      name: "chromium",
      use: { ...devices["Desktop Chrome"] },
    },
  ],
});
