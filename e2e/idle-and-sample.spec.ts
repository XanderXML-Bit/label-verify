import { test, expect } from "@playwright/test";

// ─── E2E: idle screen + sample affordance ──────────────────────────────────
//
// Covers the two-affordance idle screen and the "Try the pass sample"
// happy path through the verification pipeline. If this fails, the demo
// is broken in a way every reviewer will see on first contact.
//
// View-mode bootstrap: the production layout defaults to
// `data-mode="simple"` and hides `.detailed-only` elements (sample
// affordance, About panel, "Try a sample" panel) with `display: none`.
// Each test that needs those elements sets the persisted preference
// to `detailed` via addInitScript BEFORE the first page.goto — the
// pre-paint script in layout.tsx reads localStorage["labelverify:mode"]
// and sets `data-mode` before React mounts. (The shared
// `localStorage.setItem` step lives below so each test starts in a
// known mode regardless of test ordering.)

test.describe("Idle screen", () => {
  test.beforeEach(async ({ page }) => {
    await page.addInitScript(() => {
      try {
        window.localStorage.setItem("labelverify:mode", "detailed");
      } catch {
        /* Storage may be denied in some browsers; tests fall back to simple. */
      }
    });
  });

  test("loads with the canonical idle-screen affordances visible (detailed mode)", async ({ page }) => {
    await page.goto("/");
    await expect(
      page.getByRole("heading", { name: /Verify a label against application data/i }),
    ).toBeVisible();
    await expect(
      page.getByRole("region", { name: /Label upload area/i }),
    ).toBeVisible();
    await expect(page.getByRole("region", { name: /Try a sample/i })).toBeVisible();
    // "About this prototype" expander is detailed-only; the
    // beforeEach above primed detailed mode, so it should be visible.
    await expect(page.getByText(/About this prototype/i)).toBeVisible();
  });

  test("simple mode (default) hides the sample affordance and About panel", async ({ page }) => {
    // Clear the detailed-mode preference set in beforeEach, so the
    // page loads in the production default of simple mode.
    await page.addInitScript(() => {
      try {
        window.localStorage.removeItem("labelverify:mode");
      } catch {
        /* ignore */
      }
    });
    await page.goto("/");
    // Heading and upload zone are visible in every mode.
    await expect(
      page.getByRole("heading", { name: /Verify a label against application data/i }),
    ).toBeVisible();
    await expect(
      page.getByRole("region", { name: /Label upload area/i }),
    ).toBeVisible();
    // Sample affordance is .detailed-only — hidden via
    // `display:none !important` in simple mode.
    await expect(
      page.getByRole("region", { name: /Try a sample/i }),
    ).toBeHidden();
    await expect(page.getByText(/About this prototype/i)).toBeHidden();
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

  test("Human review queue is NOT auto-mounted on the idle screen", async ({
    page,
  }) => {
    // ReviewQueuePanel was removed from idle on 2026-05-13 because it
    // requires a DEBUG_TOKEN and was 401-ing for the demo reviewer
    // every page load. The queue is now only reachable when explicitly
    // wired (e.g. for an internal operator session). If you re-add it
    // to the idle layout, also update this expectation.
    await page.goto("/");
    await expect(
      page.getByRole("region", { name: /Human review queue/i }),
    ).toHaveCount(0);
  });
});

test.describe("Sample affordance", () => {
  // Each sample's expected verdict is asserted explicitly. A federal
  // reviewer's first interaction with the demo is to click each
  // sample and confirm the chip matches the button's "Expected: …"
  // label — this e2e suite enforces that contract against the live
  // deployment via .github/workflows/e2e-live.yml.
  //
  // The "Try the …" buttons live inside `.detailed-only`, so the
  // production default of simple mode hides them. Seed the
  // localStorage preference to "detailed" before page.goto so the
  // pre-paint script in layout.tsx unhides them.
  test.beforeEach(async ({ page }) => {
    await page.addInitScript(() => {
      try {
        window.localStorage.setItem("labelverify:mode", "detailed");
      } catch {
        /* Storage denied — fall through; later assertion will fail loudly. */
      }
    });
  });

  test("PASS sample reaches a PASS verdict", async ({ page }) => {
    await page.goto("/");
    await page.getByRole("button", { name: /Try the pass sample/i }).click();
    await expect(
      page.getByRole("region", { name: /Verification result/i }),
    ).toBeVisible({ timeout: 30_000 });
    // The verdict chip is the `aria-label="Verdict <X>"` span in the
    // SingleResult header. Reading the aria-label is more stable than
    // the inner text node, which lives inside an icon-prefixed span
    // ("⚠ REVIEW") and isn't trivially matched by an anchored regex.
    const chip = await page
      .locator('[aria-label^="Verdict "]')
      .first()
      .getAttribute("aria-label");
    expect(chip).toBe("Verdict PASS");
  });

  test("FAIL sample reaches a FAIL verdict (title-case Gov-Warning prefix)", async ({
    page,
  }) => {
    await page.goto("/");
    await page.getByRole("button", { name: /Try the fail sample/i }).click();
    await expect(
      page.getByRole("region", { name: /Verification result/i }),
    ).toBeVisible({ timeout: 30_000 });
    const chip = await page
      .locator('[aria-label^="Verdict "]')
      .first()
      .getAttribute("aria-label");
    expect(chip).toBe("Verdict FAIL");
  });

  test("REVIEW sample reaches a REVIEW verdict (Lager vs Pilsner)", async ({
    page,
  }) => {
    await page.goto("/");
    await page.getByRole("button", { name: /Try the review sample/i }).click();
    await expect(
      page.getByRole("region", { name: /Verification result/i }),
    ).toBeVisible({ timeout: 30_000 });
    const chip = await page
      .locator('[aria-label^="Verdict "]')
      .first()
      .getAttribute("aria-label");
    expect(chip).toBe("Verdict REVIEW");
  });
});
