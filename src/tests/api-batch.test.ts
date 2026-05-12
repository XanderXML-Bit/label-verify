import { describe, expect, it } from "vitest";
import { POST } from "@/app/api/verify/batch/route";
import { DEFAULT_MAX_BATCH_ITEMS, MAX_BATCH_BODY_BYTES } from "@/lib/batch-capacity";

const DECLARED_BASE = {
  brand_name: "Stone's Throw",
  class_type: "Pale Ale",
  class_category: "beer" as const,
  abv_percent: 6.4,
  net_contents: "12 fl_oz",
  producer: "Stone's Throw Brewing Co.",
  country_of_origin: "USA",
};

function makeBatchForm(count: number): FormData {
  const fd = new FormData();
  const rows = Array.from({ length: count }, (_, i) => ({
    filename: `label-${i}.jpg`,
    ...DECLARED_BASE,
  }));
  fd.append("manifest", JSON.stringify(rows));
  for (let i = 0; i < count; i++) {
    const blob = new Blob([Buffer.from([0xff, 0xd8, 0xff]) as unknown as BlobPart], {
      type: "image/jpeg",
    });
    fd.append("image", new File([blob], `label-${i}.jpg`, { type: "image/jpeg" }));
  }
  return fd;
}

function makeReq(
  form: FormData,
  headers: Record<string, string> = {},
  ip = `203.0.113.${Math.floor(Math.random() * 200) + 1}`,
): Request {
  return new Request("http://test.local/api/verify/batch", {
    method: "POST",
    body: form,
    headers: {
      "content-length": "1000",
      "x-forwarded-for": ip,
      ...headers,
    },
  });
}

describe("/api/verify/batch capacity", () => {
  it("accepts the production maximum derived from provider quota", async () => {
    const resp = await POST(makeReq(makeBatchForm(DEFAULT_MAX_BATCH_ITEMS)));
    expect(resp.status).toBe(200);
    const body = (await resp.json()) as { count: number; batchId: string };
    expect(body.count).toBe(DEFAULT_MAX_BATCH_ITEMS);
    expect(body.batchId).toMatch(/^[0-9a-f-]{36}$/);
  });

  it("rejects item counts above the derived production maximum", async () => {
    const resp = await POST(makeReq(makeBatchForm(DEFAULT_MAX_BATCH_ITEMS + 1)));
    expect(resp.status).toBe(413);
    const body = (await resp.json()) as { error: string };
    expect(body.error).toContain(String(DEFAULT_MAX_BATCH_ITEMS));
  });

  it("rejects request bodies above the aggregate memory budget before parsing", async () => {
    const resp = await POST(
      makeReq(new FormData(), { "content-length": String(MAX_BATCH_BODY_BYTES + 1) }),
    );
    expect(resp.status).toBe(413);
  });

  it("rejects missing content-length so chunked uploads cannot bypass the body cap", async () => {
    const resp = await POST(
      new Request("http://test.local/api/verify/batch", {
        method: "POST",
        body: new FormData(),
        headers: { "x-forwarded-for": "203.0.113.250" },
      }),
    );
    expect(resp.status).toBe(411);
  });

  it("rate-limits anonymous batch creation separately from single verify", async () => {
    const ip = "198.51.100.77";
    const responses = [];
    for (let i = 0; i < 4; i++) {
      responses.push(await POST(makeReq(makeBatchForm(1), {}, ip)));
    }
    expect(responses.map((r) => r.status)).toContain(429);
  });
});
