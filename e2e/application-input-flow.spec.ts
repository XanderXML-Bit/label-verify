import { test, expect } from "@playwright/test";
import { join } from "node:path";

// ─── E2E: application-input + label-only flows ─────────────────────────────
//
// Covers the two assignment-critical paths added late in the project:
//   1. Upload a label, upload an application JSON, the form prefills,
//      Verify produces a result.
//   2. Upload a label, click "Skip — extract fields without a verdict",
//      the extract-only result panel renders with the no-application
//      disclaimer banner.
//
// The Skip button is `.detailed-only`; in simple mode it's replaced by
// an inline "Extract fields from the label only →" link below the
// form. Each test seeds the persisted preference to "detailed" so
// layout.tsx's pre-paint script un-hides the Skip button before React
// mounts.
test.beforeEach(async ({ page }) => {
  await page.addInitScript(() => {
    try {
      window.localStorage.setItem("labelverify:mode", "detailed");
    } catch {
      /* ignore — simple-mode fallback will surface a clearer fail */
    }
  });
});

const SAMPLE_LABEL = join(
  process.cwd(),
  "test-data-v2",
  "labels",
  "syn-beer-0001.png",
);

const SAMPLE_APP_JSON = JSON.stringify(
  {
    brand_name: "Stone's Throw IPA",
    class_type: "India Pale Ale",
    class_category: "beer",
    abv_percent: 6.4,
    net_contents: "12 fl_oz",
    producer: "Stone Brewing Co., San Diego, CA",
    country_of_origin: "USA",
  },
  null,
  2,
);

test("label + application JSON → prefilled form → Verify", async ({ page }) => {
  await page.goto("/");
  // Use the hidden <input type="file"> directly — setInputFiles
  // bypasses the native picker entirely. The previous flow (click
  // "Choose files" + waitForEvent("filechooser") + setInputFiles)
  // was flaky against production because the button locator raced
  // page hydration. Using the input directly is the documented
  // Playwright pattern for testing file uploads.
  await page.setInputFiles('input[type="file"]', SAMPLE_LABEL);

  // Wait for the form + application card to appear.
  await expect(
    page.getByText(/Application data \(optional\)/i),
  ).toBeVisible({ timeout: 10_000 });
  // `exact: true` here so the regex doesn't strict-mode-collide with
  // the page heading "Verify a label against application data" (the
  // suffix substring would otherwise match both).
  await expect(
    page.getByRole("heading", { name: "Application data", exact: true }),
  ).toBeVisible();

  // Drop the application JSON into the application-upload picker via
  // the hidden file input.
  const buf = Buffer.from(SAMPLE_APP_JSON, "utf8");
  await page.setInputFiles(
    'input[type="file"][accept*="application/json"]',
    {
      name: "application.json",
      mimeType: "application/json",
      buffer: buf,
    },
  );

  // The form's "Brand name" textbox should now contain the prefilled value.
  await expect(
    page.getByRole("textbox", { name: /Brand name/i }),
  ).toHaveValue("Stone's Throw IPA", { timeout: 10_000 });

  await page.getByRole("button", { name: /^Verify$/ }).click();

  await expect(
    page.getByRole("region", { name: /Verification result/i }),
  ).toBeVisible({ timeout: 30_000 });
});

test('"Skip — just show what\'s on the label" → ExtractionOnly panel', async ({
  page,
}) => {
  await page.goto("/");
  await page.setInputFiles('input[type="file"]', SAMPLE_LABEL);

  await expect(
    page.getByText(/Application data \(optional\)/i),
  ).toBeVisible({ timeout: 10_000 });

  // Button label is "Skip — extract fields without a verdict" in
  // detailed mode and a shorter "Skip" affordance in simple mode;
  // match either via the shared prefix.
  await page.getByRole("button", { name: /^Skip(?:\s|$)/i }).first().click();

  await expect(
    page.getByRole("region", { name: /Extracted from label/i }),
  ).toBeVisible({ timeout: 30_000 });

  // The disclaimer banner must be present — that's the load-bearing
  // safety contract for this flow. The banner heading literally reads
  // "This is not a compliance verdict — extraction only"; the body
  // paragraph repeats the server-provided note. Match the heading
  // since it's the most stable surface.
  await expect(
    page.getByText(/not a compliance verdict|extraction only/i).first(),
  ).toBeVisible();

  // Government Warning subscores should render (federal regulation check,
  // not application-derived).
  await expect(
    page.getByRole("heading", { name: /Government Warning/i }),
  ).toBeVisible();

  // And there should NOT be a top-level PASS/FAIL Verdict chip — extract
  // mode doesn't produce one.
  const verdictHeader = page.locator('text=/^Verdict:$/');
  await expect(verdictHeader).toHaveCount(0);
});
