import { test, expect } from "@playwright/test";
import { join } from "node:path";

// ─── E2E: application-input + label-only flows ─────────────────────────────
//
// Covers the two assignment-critical paths added late in the project:
//   1. Upload a label, upload an application JSON, the form prefills,
//      Verify produces a result.
//   2. Upload a label, click "Skip — just show what's on the label",
//      the extract-only result panel renders with the no-application
//      disclaimer banner.

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
  await page
    .getByRole("button", { name: /Choose files/i })
    .click({ trial: false });
  const fileChooser = page.waitForEvent("filechooser");
  // Use the upload zone's "Choose files" button (the only one on idle).
  // The trial:false click above already fired the chooser, but Playwright
  // expects us to actually await it after the click.
  await page.setInputFiles('input[type="file"]', SAMPLE_LABEL).catch(() => {});

  // Wait for the form + application card to appear.
  await expect(
    page.getByText(/Application data \(optional\)/i),
  ).toBeVisible({ timeout: 10_000 });
  await expect(
    page.getByRole("heading", { name: /Application data$/i }),
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

  await fileChooser.catch(() => undefined);
});

test('"Skip — just show what\'s on the label" → ExtractionOnly panel', async ({
  page,
}) => {
  await page.goto("/");
  await page.setInputFiles('input[type="file"]', SAMPLE_LABEL);

  await expect(
    page.getByText(/Application data \(optional\)/i),
  ).toBeVisible({ timeout: 10_000 });

  await page.getByRole("button", { name: /Skip — just show/i }).click();

  await expect(
    page.getByRole("region", { name: /Extracted from label/i }),
  ).toBeVisible({ timeout: 30_000 });

  // The disclaimer banner must be present — that's the load-bearing
  // safety contract for this flow.
  await expect(page.getByText(/Application data not provided/i)).toBeVisible();

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
