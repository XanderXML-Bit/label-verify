import { expect, test } from "@playwright/test";
import { isOfflineDemo } from "./demo-mode";

const uploadRoutes = [
  "/api/verify",
  "/api/extract",
  "/api/verify/batch",
  "/api/application/parse",
];
const requestId = "upload-error-test";
const headers = { "content-type": "application/json", "x-request-id": requestId };

test.beforeEach(async ({ baseURL }) => {
  test.skip(
    !baseURL || !["127.0.0.1", "localhost", "[::1]"].includes(new URL(baseURL).hostname),
    "requires a local Next.js server",
  );
});

for (const route of uploadRoutes.slice(0, 2)) {
  test(`${route} keeps the request ID when its POST handler throws`, async ({ request }) => {
    test.skip(await isOfflineDemo(request), "requires live mode to parse the body");
    const response = await request.post(route, { headers, data: "null" });
    expect(response.status()).toBe(500);
    expect(response.headers()["x-request-id"]).toBe(requestId);
  });
}

for (const route of uploadRoutes) {
  test(`${route} keeps the request ID on a 405 for a PUT with a body`, async ({ request }) => {
    const response = await request.put(route, { headers, data: "{}" });
    expect(response.status()).toBe(405);
    expect(response.headers()["x-request-id"]).toBe(requestId);
  });
}
