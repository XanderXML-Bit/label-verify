import { request as httpRequest } from "node:http";
import { request as httpsRequest } from "node:https";
import { expect, test } from "@playwright/test";
import { isOfflineDemo } from "./demo-mode";

const boundary = "offline-upload-test";
const body = Buffer.from(
  `--${boundary}\r\nContent-Disposition: form-data; name="image"; filename="test.png"\r\n` +
  `Content-Type: image/png\r\n\r\nsynthetic upload\r\n--${boundary}--\r\n`,
);
const routes = [
  "/api/verify",
  "/api/extract",
  "/api/verify/batch",
  "/api/application/parse",
];

function sendPausedUpload(url: URL, headers: Record<string, string>) {
  return new Promise<{
    status: number | undefined;
    requestId: string | string[] | undefined;
    body: string;
    sentRemainder: boolean;
  }>((resolve, reject) => {
    const request = url.protocol === "https:" ? httpsRequest : httpRequest;
    let sentRemainder = false;
    const req = request(url, {
      method: "POST",
      headers: { "content-type": `multipart/form-data; boundary=${boundary}`, ...headers },
      agent: false,
      signal: AbortSignal.timeout(10_000),
    }, (res) => {
      clearTimeout(resume);
      let payload = "";
      res.setEncoding("utf8");
      res.on("data", (chunk: string) => { payload += chunk; });
      res.on("error", reject);
      res.on("end", () => {
        resolve({
          status: res.statusCode,
          requestId: res.headers["x-request-id"],
          body: payload,
          sentRemainder,
        });
        req.destroy();
      });
    });
    // Withhold the remaining bytes. Release them only to let a buffering
    // server answer, so a regression fails the timing assertion below.
    const resume = setTimeout(() => {
      sentRemainder = true;
      req.end(body.subarray(8));
    }, 5_000);
    req.on("error", (err) => {
      clearTimeout(resume);
      reject(err);
    });
    req.write(body.subarray(0, 8));
  });
}

test.beforeEach(async ({ baseURL, request }) => {
  // A hosting proxy can buffer uploads before forwarding them to Next.js.
  test.skip(
    !baseURL || !["127.0.0.1", "localhost", "[::1]"].includes(new URL(baseURL).hostname),
    "requires a local Next.js server",
  );
  test.skip(!(await isOfflineDemo(request)), "server runs live models");
});

for (const route of routes) {
  for (const framing of ["length", "chunked"] as const) {
    test(`${route} refuses a paused ${framing} upload`, async ({ baseURL }) => {
      const headers: Record<string, string> = framing === "length"
        ? { "content-length": String(body.length), "x-request-id": "paused-upload-test" }
        : { "transfer-encoding": "chunked", "x-request-id": "invalid id" };
      const res = await sendPausedUpload(new URL(route, baseURL), headers);
      expect(res.status).toBe(503);
      expect(JSON.parse(res.body)).toMatchObject({ code: "offline-demo" });
      expect(res.sentRemainder, "response arrived after the second chunk was sent").toBe(false);
      if (framing === "length") {
        expect(res.requestId).toBe("paused-upload-test");
      } else {
        expect(res.requestId).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i);
      }
    });
  }
}
