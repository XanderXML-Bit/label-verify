import { test, expect } from "@playwright/test";
import { join } from "node:path";

// ─── E2E: friendlyError mapping ────────────────────────────────────────────
//
// page.tsx:friendlyError() translates raw HTTP errors into user-facing
// copy. A regression here turns "rate-limited" into "HTTP 429" silently,
// which is the kind of bug that survives forever because the
// developer-tooled "HTTP 429" string LOOKS like a real error message.
//
// This suite mocks /api/verify with each status code and asserts the
// user sees the friendly copy, not the raw status.

const SAMPLE_LABEL = join(
  process.cwd(),
  "test-data-v2",
  "labels",
  "syn-beer-0001.png",
);

async function uploadAndSubmit(
  page: Parameters<Parameters<typeof test>[1]>[0]["page"],
): Promise<void> {
  await page.goto("/");
  await page.setInputFiles('input[type="file"]', SAMPLE_LABEL);
  await expect(
    page.getByText(/Application data \(optional\)/i),
  ).toBeVisible({ timeout: 10_000 });
  // Fill the minimum required fields so the form actually POSTs.
  await page.getByRole("textbox", { name: /Brand name/i }).fill("TestBrand");
  await page.getByRole("textbox", { name: /Class \/ type/i }).fill("IPA");
  await page.getByRole("spinbutton", { name: /ABV/i }).fill("5");
  await page
    .getByRole("spinbutton", { name: /Net contents value/i })
    .fill("12");
  await page.getByRole("button", { name: /^Verify$/ }).click();
}

test.describe("friendlyError translates raw HTTP errors", () => {
  test("429 → 'per-minute request limit' copy", async ({ page }) => {
    await page.route("**/api/verify", (route) =>
      route.fulfill({
        status: 429,
        contentType: "application/json",
        body: JSON.stringify({ error: "Rate limit exceeded." }),
      }),
    );
    await uploadAndSubmit(page);
    await expect(
      page.getByText(/per-minute request limit/i),
    ).toBeVisible({ timeout: 10_000 });
  });

  test("413 → 'file is too large' copy", async ({ page }) => {
    await page.route("**/api/verify", (route) =>
      route.fulfill({
        status: 413,
        contentType: "application/json",
        body: JSON.stringify({ error: "Image exceeds limit." }),
      }),
    );
    await uploadAndSubmit(page);
    await expect(page.getByText(/too large/i)).toBeVisible({ timeout: 10_000 });
  });

  test("415 → 'file type isn't supported' copy", async ({ page }) => {
    await page.route("**/api/verify", (route) =>
      route.fulfill({
        status: 415,
        contentType: "application/json",
        body: JSON.stringify({ error: "Unsupported MIME." }),
      }),
    );
    await uploadAndSubmit(page);
    await expect(page.getByText(/isn'?t supported/i)).toBeVisible({
      timeout: 10_000,
    });
  });

  test("503 → 'verification service is unavailable' copy", async ({ page }) => {
    await page.route("**/api/verify", (route) =>
      route.fulfill({
        status: 503,
        contentType: "application/json",
        body: JSON.stringify({ error: "UNAVAILABLE" }),
      }),
    );
    await uploadAndSubmit(page);
    await expect(page.getByText(/unavailable/i)).toBeVisible({
      timeout: 10_000,
    });
  });

  test("504 → 'cold-starting' copy", async ({ page }) => {
    await page.route("**/api/verify", (route) =>
      route.fulfill({
        status: 504,
        contentType: "application/json",
        body: JSON.stringify({ error: "timeout" }),
      }),
    );
    await uploadAndSubmit(page);
    await expect(page.getByText(/cold-starting|took too long/i)).toBeVisible({
      timeout: 10_000,
    });
  });

  test("500 → 'something went wrong on our side' copy", async ({ page }) => {
    await page.route("**/api/verify", (route) =>
      route.fulfill({
        status: 500,
        contentType: "application/json",
        body: JSON.stringify({ error: "Internal" }),
      }),
    );
    await uploadAndSubmit(page);
    await expect(page.getByText(/something went wrong/i)).toBeVisible({
      timeout: 10_000,
    });
  });

  test("Network failure → 'couldn't reach the verifier' copy", async ({
    page,
  }) => {
    // Abort the request to simulate a network drop.
    await page.route("**/api/verify", (route) => route.abort("failed"));
    await uploadAndSubmit(page);
    // Wave-35o: the error UI's "Try again" button also matches a
    // permissive `/try again/i` regex, so a bare getByText trips
    // strict-mode (paragraph + button both match). Scope to the
    // alert region and assert against the load-bearing copy only.
    const alert = page.getByRole("alert").filter({
      hasText: /couldn'?t reach the verifier/i,
    });
    await expect(alert).toBeVisible({ timeout: 10_000 });
  });
});
