import { test, expect } from "@playwright/test";

// ─── E2E: sample retry after error ─────────────────────────────────────────
//
// When a sample-button click fails (network blip, cold-start 503,
// transient 500), page.tsx is supposed to offer a "Retry this sample"
// affordance instead of "Try again" (which dumps the user back to
// idle and loses the sample context). This is the user-friendliest
// path — one click recovers, no need to re-find the sample button.

test("PASS sample 500 → 'Retry this sample' → succeeds on second attempt", async ({
  page,
}) => {
  // The "Try the pass sample" button lives inside `.detailed-only`,
  // so the production default of simple mode hides it. Seed the
  // persisted preference to "detailed" so layout.tsx's pre-paint
  // script un-hides the sample affordance before React mounts.
  await page.addInitScript(() => {
    try {
      window.localStorage.setItem("labelverify:mode", "detailed");
    } catch {
      /* ignore */
    }
  });
  let callCount = 0;
  await page.route("**/api/verify", async (route) => {
    callCount++;
    if (callCount === 1) {
      // First call fails.
      await route.fulfill({
        status: 500,
        contentType: "application/json",
        body: JSON.stringify({ error: "Internal" }),
      });
    } else {
      // Second call returns a synthetic PASS verdict.
      // SingleResult unconditionally reads gov.subscores.{text,caps,bold,size}.status
      // (see src/app/components/SingleResult.tsx:169-188). The mock must
      // populate all four subscores or the component throws on render and
      // the assertion below times out instead of failing-fast with a clear
      // message. Caught by production-readiness audit 2026-05-13.
      await route.fulfill({
        status: 200,
        contentType: "application/json",
        body: JSON.stringify({
          verdict: "pass",
          imageQuality: "good",
          fields: {},
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
          extracted: {},
          timings: { preprocess: 1, ocr: 1, vision: 1, matching: 1, total: 4 },
          modelId: "mock",
          modelVersion: "mock-v1",
          modeUsed: "default",
          requiresHumanReview: false,
          reviewReasons: [],
        }),
      });
    }
  });

  await page.goto("/");
  await page.getByRole("button", { name: /Try the pass sample/i }).click();

  // First attempt fails — error banner with the friendly copy.
  await expect(page.getByText(/something went wrong/i)).toBeVisible({
    timeout: 10_000,
  });

  // The retry affordance should be a "Retry this sample" or similar
  // button (NOT just generic "Try again", which routes to idle).
  const retry = page.getByRole("button", { name: /retry.*sample/i });
  await expect(retry).toBeVisible();
  await retry.click();

  // Second call succeeds — verdict chip shows PASS.
  await expect(
    page.getByRole("region", { name: /Verification result/i }),
  ).toBeVisible({ timeout: 10_000 });
  expect(callCount).toBe(2);
});
