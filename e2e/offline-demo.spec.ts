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

  test("a visitor's own image or document is never sent", async ({ page }) => {
    // Records every request with a body. A sample run sends only the
    // sample id and declared JSON; a visitor's file must send nothing.
    const posts: { url: string; bytes: number; hasFilePart: boolean }[] = [];
    page.on("request", (r) => {
      const body = r.postDataBuffer();
      if (!body) return;
      posts.push({
        url: r.url(),
        bytes: body.byteLength,
        hasFilePart: /filename="/.test(body.toString("latin1")),
      });
    });
    await page.goto("/");
    const input = page.locator('input[type="file"]:not([webkitdirectory])').first();
    const png = Buffer.from(
      "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==",
      "base64",
    );
    await input.setInputFiles([
      { name: "my-label.png", mimeType: "image/png", buffer: png },
      {
        name: "my-label.json",
        mimeType: "application/json",
        buffer: Buffer.from(JSON.stringify({ brand_name: "Visitor Brand" })),
      },
    ]);
    await expect(page.getByTestId("offline-upload-blocked")).toContainText(
      "Your file was not uploaded.",
    );
    await page.waitForTimeout(1_000);
    expect(posts.filter((p) => p.hasFilePart)).toEqual([]);
    expect(posts.filter((p) => /\/api\/(verify|extract|application\/parse)/.test(p.url))).toEqual([]);
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
