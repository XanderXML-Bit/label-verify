import { test, expect } from "@playwright/test";

// ─── E2E: mobile header layout stability ───────────────────────────────────
//
// Lighthouse mobile (412 px viewport) measured CLS 0.184 on 2026-11-08.
// The ReviewerBadge pre-hydration placeholder was hidden below `sm`, so
// the header controls wrapped to a second row when the real button
// mounted. That pushed `main#main` down 54 px. This test records layout
// shifts from first paint and fails if the header changes height.

test.use({
  viewport: { width: 412, height: 823 },
  isMobile: true,
  hasTouch: true,
});

test("Header keeps its height through hydration at 412 px", async ({ page }) => {
  await page.addInitScript(() => {
    const w = window as unknown as {
      __shifts: number[];
      __headerHeights: number[];
    };
    w.__shifts = [];
    w.__headerHeights = [];
    new PerformanceObserver((list) => {
      for (const entry of list.getEntries()) {
        const shift = entry as PerformanceEntry & {
          value: number;
          hadRecentInput: boolean;
        };
        if (!shift.hadRecentInput) w.__shifts.push(shift.value);
      }
    }).observe({ type: "layout-shift", buffered: true });
    document.addEventListener("DOMContentLoaded", () => {
      const header = document.querySelector("header");
      if (header) w.__headerHeights.push(header.getBoundingClientRect().height);
    });
  });

  await page.goto("/");
  // The real badge button replaces the placeholder after hydration.
  await expect(page.getByTestId("reviewer-badge-placeholder")).toHaveCount(0);
  await page.waitForTimeout(500);

  const result = await page.evaluate(() => {
    const w = window as unknown as {
      __shifts: number[];
      __headerHeights: number[];
    };
    return {
      cls: w.__shifts.reduce((a, b) => a + b, 0),
      before: w.__headerHeights[0],
      after: document.querySelector("header")!.getBoundingClientRect().height,
    };
  });

  expect(result.after).toBe(result.before);
  expect(result.cls).toBeLessThanOrEqual(0.01);
});
