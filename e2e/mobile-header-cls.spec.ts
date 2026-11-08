import { test, expect, type Browser } from "@playwright/test";

// ─── E2E: mobile header layout stability ───────────────────────────────────
//
// Lighthouse mobile (412 px viewport) measured CLS 0.184 on 2026-11-08.
// The ReviewerBadge pre-hydration placeholder was hidden below `sm`, so
// the header controls wrapped to a second row when the real button
// mounted. That pushed `main#main` down 54 px. These tests compare the
// server-rendered header (JavaScript off) with the hydrated header and
// sum the layout shifts recorded from first paint.
//
// `layout-shift` entries exist only in Chromium, so other browsers skip.

function mobile(width: number) {
  return { viewport: { width, height: 823 }, isMobile: true, hasTouch: true };
}

async function serverHeaderHeight(
  browser: Browser,
  width: number,
): Promise<number> {
  const ctx = await browser.newContext({
    ...mobile(width),
    javaScriptEnabled: false,
  });
  try {
    const page = await ctx.newPage();
    await page.goto("/");
    return await page
      .locator("body > header")
      .evaluate((el) => el.getBoundingClientRect().height);
  } finally {
    await ctx.close();
  }
}

for (const width of [320, 360, 412])
  for (const stored of [null, "J.SMITH-0421-REVIEWER-LONG-ID"]) {
    test(`Header keeps its height through hydration at ${width} px (reviewer: ${stored ?? "none"})`, async ({
      browser,
      browserName,
    }) => {
      test.skip(browserName !== "chromium", "layout-shift is Chromium-only");

      const before = await serverHeaderHeight(browser, width);

      const ctx = await browser.newContext(mobile(width));
      try {
        const page = await ctx.newPage();
        await page.addInitScript((reviewer) => {
          if (reviewer)
            window.localStorage.setItem("labelverify:reviewer", reviewer);
          const w = window as unknown as { __shifts: number[] };
          w.__shifts = [];
          new PerformanceObserver((list) => {
            for (const entry of list.getEntries()) {
              const shift = entry as PerformanceEntry & {
                value: number;
                hadRecentInput: boolean;
              };
              if (!shift.hadRecentInput) w.__shifts.push(shift.value);
            }
          }).observe({ type: "layout-shift", buffered: true });
        }, stored);

        await page.goto("/");
        // The real badge button replaces the placeholder after hydration.
        await expect(
          page.getByRole("button", { name: /^Reviewer:/ }),
        ).toBeVisible();
        await page.waitForTimeout(500);

        const result = await page.evaluate(() => ({
          cls: (window as unknown as { __shifts: number[] }).__shifts.reduce(
            (a, b) => a + b,
            0,
          ),
          after: document
            .querySelector("body > header")!
            .getBoundingClientRect().height,
        }));

        expect(result.after).toBeCloseTo(before, 0);
        expect(result.cls).toBeLessThanOrEqual(0.01);
      } finally {
        await ctx.close();
      }
    });
  }
