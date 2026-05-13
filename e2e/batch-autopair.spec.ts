import { test, expect } from "@playwright/test";
import { join } from "node:path";

// ─── E2E: batch autopair happy path ────────────────────────────────────────
//
// Batch flows had ZERO E2E coverage as of 2026-05-13 per Agent A's gap
// audit, despite being the highest-complexity surface in the app (auto-
// pairing, content-fallback, broadcast, inline-manifest detection) and
// the place where the Vercel serverless-instance 404 bug originated.
//
// This spec covers the autopair happy path: drop 2 images + 2 stem-
// matched application JSONs, the UI auto-detects the pairing, shows
// the "Detected" summary, and on "Verify batch" the inline batch
// response paints terminal-state rows.

const SAMPLE_LABEL_1 = join(
  process.cwd(),
  "test-data-v2",
  "labels",
  "syn-beer-0001.png",
);
const SAMPLE_LABEL_2 = join(
  process.cwd(),
  "test-data-v2",
  "labels",
  "syn-wine-0002.png",
);

function appJsonFor(brand: string, classType: string): Buffer {
  return Buffer.from(
    JSON.stringify({
      brand_name: brand,
      class_type: classType,
      class_category: "beer",
      abv_percent: 5.0,
      net_contents: "12 fl_oz",
      producer: "Test Brewing Co., Asheville, NC",
      country_of_origin: "USA",
    }),
  );
}

test("Drop 2 images + 2 stem-matched apps → batch-pending autopair → inline results", async ({
  page,
}) => {
  // Mock the batch endpoint to return inline terminal-state results
  // for both items. The real route fires verifyLabel under the hood;
  // we mock to avoid real vision API costs.
  await page.route("**/api/verify/batch", (route) =>
    route.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify({
        batchId: "test-batch-1",
        count: 2,
        pairing: {
          mode: "auto-stem",
          totalItems: 2,
          pairedCount: 2,
          pairs: [
            {
              image: "syn-beer-0001.png",
              application: "syn-beer-0001.json",
              stem: "syn-beer-0001",
              source: "filename-strict",
            },
            {
              image: "syn-wine-0002.png",
              application: "syn-wine-0002.json",
              stem: "syn-wine-0002",
              source: "filename-strict",
            },
          ],
          unpairedImages: [],
          unpairedApplications: [],
          ignored: [],
        },
        pairingErrors: [],
        pairingWarnings: [],
        inline: true,
        results: [
          {
            index: 0,
            filename: "syn-beer-0001.png",
            status: "done",
            result: {
              verdict: "pass",
              imageQuality: "good",
              fields: {},
              governmentWarning: {
                status: "pass",
                confidence: 0.9,
                subscores: {},
              },
              extracted: {},
              timings: { preprocess: 1, ocr: 1, vision: 1, matching: 1, total: 4 },
              modelId: "mock",
              modelVersion: "mock-v1",
              modeUsed: "default",
              requiresHumanReview: false,
              reviewReasons: [],
            },
          },
          {
            index: 1,
            filename: "syn-wine-0002.png",
            status: "done",
            result: {
              verdict: "pass",
              imageQuality: "good",
              fields: {},
              governmentWarning: {
                status: "pass",
                confidence: 0.9,
                subscores: {},
              },
              extracted: {},
              timings: { preprocess: 1, ocr: 1, vision: 1, matching: 1, total: 4 },
              modelId: "mock",
              modelVersion: "mock-v1",
              modeUsed: "default",
              requiresHumanReview: false,
              reviewReasons: [],
            },
          },
        ],
        summary: { passed: 2, failed: 0, review: 0, errored: 0 },
        elapsedMs: 8,
      }),
    }),
  );

  await page.goto("/");
  // Drop 2 images + 2 matching app JSONs simultaneously through the
  // unified upload picker. The page's handleFiles infers batch mode
  // because there are ≥ 2 images, and autoPair=true because apps came
  // along too.
  await page.setInputFiles('input[type="file"]', [
    SAMPLE_LABEL_1,
    SAMPLE_LABEL_2,
    {
      name: "syn-beer-0001.json",
      mimeType: "application/json",
      buffer: appJsonFor("Stone's Throw IPA", "India Pale Ale"),
    },
    {
      name: "syn-wine-0002.json",
      mimeType: "application/json",
      buffer: appJsonFor("Cherry Cellars Cab", "Cabernet Sauvignon"),
    },
  ]);

  // The batch-pending autoPair screen should show a "Detected" summary.
  await expect(page.getByText(/Detected/i).first()).toBeVisible({
    timeout: 10_000,
  });

  // Click "Verify batch" — uses the actual batch endpoint mock.
  await page
    .getByRole("button", { name: /Verify batch|Verify all/i })
    .first()
    .click();

  // The BatchView should mount and surface both rows with pass verdicts.
  await expect(
    page.getByText("syn-beer-0001.png").first(),
  ).toBeVisible({ timeout: 15_000 });
  await expect(
    page.getByText("syn-wine-0002.png").first(),
  ).toBeVisible({ timeout: 15_000 });
});
