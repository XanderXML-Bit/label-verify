import { describe, expect, it } from "vitest";
import { POST } from "@/app/api/verify/batch/route";

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

function makeReq(form: FormData, headers: Record<string, string> = {}): Request {
  return new Request("http://test.local/api/verify/batch", {
    method: "POST",
    body: form,
    headers,
  });
}

describe("/api/verify/batch capacity", () => {
  it("accepts the production maximum of 1000 items", async () => {
    const resp = await POST(makeReq(makeBatchForm(1000)));
    expect(resp.status).toBe(200);
    const body = (await resp.json()) as { count: number; batchId: string };
    expect(body.count).toBe(1000);
    expect(body.batchId).toMatch(/^[0-9a-f-]{36}$/);
  });

  it("rejects item counts above the production maximum", async () => {
    const resp = await POST(makeReq(makeBatchForm(1001)));
    expect(resp.status).toBe(413);
    const body = (await resp.json()) as { error: string };
    expect(body.error).toMatch(/1000/);
  });

  it("rejects request bodies above the aggregate memory budget before parsing", async () => {
    const resp = await POST(
      makeReq(new FormData(), { "content-length": String(1024 * 1024 * 1024 + 1) }),
    );
    expect(resp.status).toBe(413);
  });
});
