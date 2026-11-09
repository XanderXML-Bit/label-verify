import { test, expect } from "@playwright/test";

// A fresh page load must not move focus or scroll. An earlier effect
// focused the "Choose files" button on mount, which scrolled a 390 px
// wide phone about 750 px down, past the offline notice and the samples.
for (const viewport of [
  { width: 390, height: 844 },
  { width: 1440, height: 900 },
]) {
  test(`no focus or scroll on load at ${viewport.width}px`, async ({ page }) => {
    await page.setViewportSize(viewport);
    await page.goto("/");
    await page.waitForLoadState("load");
    await page.waitForTimeout(500);
    const state = await page.evaluate(() => ({
      scrollY: window.scrollY,
      active: document.activeElement?.tagName ?? null,
    }));
    expect(state.scrollY).toBe(0);
    expect(state.active).toBe("BODY");
  });
}
