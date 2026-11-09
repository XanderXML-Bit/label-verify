import { test, expect } from "@playwright/test";
import { isOfflineDemo } from "./demo-mode";

// ─── E2E: keyless public demo (owner decision 2026-11-08) ──────────────────
//
// In offline-demo mode the page states that no AI model or API key is
// used, the samples work in the default simple mode, the result is
// labelled as an offline sample, an upload explains why it is turned off,
// and the browser never talks to a model provider.

const PROVIDER_HOSTS =
  /generativelanguage\.googleapis\.com|api\.openai\.com|api\.anthropic\.com|openrouter\.ai/;

test.describe("Offline demo", () => {
  test.beforeEach(async ({ request }) => {
    test.skip(!(await isOfflineDemo(request)), "server runs live models");
  });

  test("notice, labelled sample result, and no provider traffic", async ({ page }) => {
    const providerRequests: string[] = [];
    page.on("request", (r) => {
      if (PROVIDER_HOSTS.test(r.url())) providerRequests.push(r.url());
    });
    await page.goto("/");
    await expect(page.getByTestId("offline-demo-notice")).toContainText(
      /no AI model calls and uses no API keys/i,
    );
    // Simple mode is the default; the samples must still be reachable.
    await page.getByRole("button", { name: /PASS sample/ }).click();
    await expect(
      page.getByRole("region", { name: /Verification result/i }),
    ).toBeVisible({ timeout: 30_000 });
    await expect(page.getByTestId("offline-sample-note")).toContainText(
      /No AI model was called/,
    );
    const chip = await page
      .locator('[aria-label^="Verdict "]')
      .first()
      .getAttribute("aria-label");
    expect(chip).toBe("Verdict PASS");
    expect(providerRequests).toEqual([]);
  });

  test("API answers uploads with the offline-demo explanation", async ({ request }) => {
    const res = await request.post("/api/verify", {
      multipart: {
        image: { name: "x.png", mimeType: "image/png", buffer: Buffer.from([0x89, 0x50, 0x4e, 0x47]) },
        declared: "{}",
      },
    });
    expect(res.status()).toBe(503);
    const body = (await res.json()) as { code: string; error: string };
    expect(body.code).toBe("offline-demo");
    expect(body.error).toMatch(/no AI model calls and uses no API keys/);
  });
});
