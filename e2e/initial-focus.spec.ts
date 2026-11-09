import { test, expect, devices, type Page } from "@playwright/test";

// A fresh page load must not move focus or scroll. An earlier effect
// focused the "Choose files" button on mount, which scrolled a 390 px
// wide phone about 750 px down, past the offline notice and the samples.

const CHOOSE_FILES =
  /Choose files: upload label images, drag and drop, or press Enter to browse/i;

// Readiness signal instead of a fixed wait. The reviewer badge renders a
// placeholder until its mount effect runs, then swaps in the real
// "Reviewer: …" button. React flushes the passive effects of one hydration
// commit together, so once that button exists every mount effect on the
// page (including UploadZone's) has run. Two animation frames then let
// any focus-driven scroll settle before the state is read.
async function waitForHydration(page: Page): Promise<void> {
  await expect(page.getByRole("button", { name: /^Reviewer:/ })).toBeVisible();
  await page.evaluate(
    () =>
      new Promise<void>((resolve) =>
        requestAnimationFrame(() => requestAnimationFrame(() => resolve())),
      ),
  );
}

async function focusAndScroll(page: Page) {
  return page.evaluate(() => ({
    scrollY: window.scrollY,
    active: document.activeElement?.tagName ?? null,
  }));
}

for (const viewport of [
  { width: 390, height: 844 },
  { width: 1440, height: 900 },
]) {
  test(`no focus or scroll on load at ${viewport.width}px`, async ({ page }) => {
    await page.setViewportSize(viewport);
    await page.goto("/");
    await waitForHydration(page);
    const state = await focusAndScroll(page);
    expect(state.scrollY).toBe(0);
    expect(state.active).toBe("BODY");
  });
}

test.describe("iOS user agent (iPhone 13)", () => {
  // The iPhone 13 descriptor defaults to WebKit; keep the project's
  // browser and take only the viewport, UA, touch and scale settings.
  // eslint-disable-next-line @typescript-eslint/no-unused-vars
  const { defaultBrowserType, ...iphone } = devices["iPhone 13"];
  test.use(iphone);

  test("no focus or scroll on load; chooser moves focus in and back out", async ({
    page,
  }) => {
    await page.goto("/");
    const trigger = page.getByRole("button", { name: CHOOSE_FILES });
    // On iOS the trigger becomes a menu button after its mount effect runs.
    await expect(trigger).toHaveAttribute("aria-haspopup", "menu");
    await waitForHydration(page);

    const onLoad = await focusAndScroll(page);
    expect(onLoad.scrollY).toBe(0);
    expect(onLoad.active).toBe("BODY");

    await trigger.click();
    await expect(trigger).toHaveAttribute("aria-expanded", "true");
    const firstItem = page
      .getByRole("menu", { name: /Pick a source for the upload/i })
      .getByRole("menuitem")
      .first();
    await expect(firstItem).toBeFocused();

    await page.keyboard.press("Escape");
    await expect(trigger).toHaveAttribute("aria-expanded", "false");
    await expect(page.getByRole("menu")).toHaveCount(0);
    await expect(trigger).toBeFocused();
  });
});
