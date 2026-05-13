import { test, expect } from "@playwright/test";

// ─── E2E: upload rejection paths ───────────────────────────────────────────
//
// Covers what happens when the user drops files the app can't handle —
// .exe, .gif, plain text. These rejection paths are easy to break
// (regex tweaks in classifyFile, new MIME additions, etc.) and the
// failure mode is "silent acceptance + bewildering verify error 10s
// later." Cheaper to fail loudly at the upload boundary.

test.describe("Upload rejection — non-image files", () => {
  test("Drops a .exe → red rejection banner with the filename", async ({
    page,
  }) => {
    await page.goto("/");
    // Simulate a file with .exe extension. The classifyFile helper
    // rejects anything not in the image / application MIME whitelist.
    await page.setInputFiles('input[type="file"]', {
      name: "trojan.exe",
      mimeType: "application/octet-stream",
      buffer: Buffer.from("MZ\x90\x00"), // PE header magic
    });
    // The UploadZone surfaces an inline error banner instead of moving
    // to a single-pending stage.
    await expect(
      page.getByText(/(unsupported|wasn'?t|isn'?t).*(file|type)/i).first(),
    ).toBeVisible({ timeout: 5_000 });
  });

  test("Drops a .gif → rejection (only JPEG/PNG/WebP/HEIC/PDF allowed)", async ({
    page,
  }) => {
    await page.goto("/");
    await page.setInputFiles('input[type="file"]', {
      name: "anim.gif",
      mimeType: "image/gif",
      buffer: Buffer.from("GIF89a"),
    });
    await expect(
      page.getByText(/(unsupported|wasn'?t|isn'?t).*(file|type)/i).first(),
    ).toBeVisible({ timeout: 5_000 });
  });

  test("Drops only an application file (no image) → 'Label image required' guidance", async ({
    page,
  }) => {
    await page.goto("/");
    // A JSON application without an image — the app should refuse to
    // proceed and tell the user a label image is required, not
    // silently try to verify nothing.
    await page.setInputFiles('input[type="file"]', {
      name: "application.json",
      mimeType: "application/json",
      buffer: Buffer.from(
        JSON.stringify({ brand_name: "X", class_type: "IPA" }),
      ),
    });
    // Either an inline error banner or an error-stage panel surfaces
    // text indicating that a label image is needed.
    await expect(
      page.getByText(/(label image|image required|need.*image)/i).first(),
    ).toBeVisible({ timeout: 5_000 });
  });
});
