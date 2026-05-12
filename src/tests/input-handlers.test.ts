import { describe, expect, it, vi, beforeEach, afterEach } from "vitest";
import { UrlFetchError, fetchUrlImage } from "@/lib/input-handlers";

// We don't hit the network in tests — stub global fetch + DNS.

vi.mock("node:dns/promises", () => ({
  lookup: vi.fn(),
}));
import { lookup as dnsLookup } from "node:dns/promises";

const originalFetch = globalThis.fetch;

beforeEach(() => {
  vi.clearAllMocks();
});
afterEach(() => {
  globalThis.fetch = originalFetch;
});

function stubFetch(spec: {
  status?: number;
  body?: Buffer;
  contentType?: string;
  location?: string;
}) {
  const status = spec.status ?? 200;
  globalThis.fetch = vi.fn().mockImplementation(async () => {
    const headers = new Map<string, string>();
    if (spec.contentType) headers.set("content-type", spec.contentType);
    if (spec.location) headers.set("location", spec.location);
    return {
      status,
      ok: status >= 200 && status < 300,
      headers: {
        get: (k: string) => headers.get(k.toLowerCase()) ?? null,
      },
      body: spec.body
        ? new ReadableStream({
            start(controller) {
              controller.enqueue(new Uint8Array(spec.body!));
              controller.close();
            },
          })
        : null,
    } as unknown as Response;
  }) as typeof fetch;
}

describe("fetchUrlImage — SSRF rejection", () => {
  it("rejects non-http(s) scheme", async () => {
    await expect(fetchUrlImage("file:///etc/passwd")).rejects.toBeInstanceOf(UrlFetchError);
  });

  it("rejects empty input", async () => {
    await expect(fetchUrlImage("   ")).rejects.toBeInstanceOf(UrlFetchError);
  });

  it("rejects loopback IP literal", async () => {
    await expect(fetchUrlImage("http://127.0.0.1/x")).rejects.toBeInstanceOf(UrlFetchError);
    await expect(fetchUrlImage("http://[::1]/x")).rejects.toBeInstanceOf(UrlFetchError);
  });

  it("rejects RFC1918 IP literal", async () => {
    await expect(fetchUrlImage("http://10.0.0.5/x")).rejects.toBeInstanceOf(UrlFetchError);
    await expect(fetchUrlImage("http://192.168.1.1/x")).rejects.toBeInstanceOf(UrlFetchError);
    await expect(fetchUrlImage("http://172.16.0.1/x")).rejects.toBeInstanceOf(UrlFetchError);
  });

  it("rejects link-local IP literal", async () => {
    await expect(fetchUrlImage("http://169.254.169.254/x")).rejects.toBeInstanceOf(UrlFetchError);
  });

  it("rejects hostname resolving to private IP", async () => {
    (dnsLookup as ReturnType<typeof vi.fn>).mockResolvedValue([
      { address: "10.5.5.5", family: 4 },
    ]);
    await expect(fetchUrlImage("https://internal.example.com/img.png")).rejects.toBeInstanceOf(UrlFetchError);
  });
});

describe("fetchUrlImage — happy path", () => {
  it("fetches a small public PNG", async () => {
    (dnsLookup as ReturnType<typeof vi.fn>).mockResolvedValue([
      { address: "203.0.113.10", family: 4 },
    ]);
    stubFetch({
      status: 200,
      contentType: "image/png",
      body: Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    });
    const result = await fetchUrlImage("https://images.example.com/x.png");
    expect(result.mime).toBe("image/png");
    expect(result.buffer.length).toBeGreaterThan(0);
  });

  it("rejects an unsupported MIME", async () => {
    (dnsLookup as ReturnType<typeof vi.fn>).mockResolvedValue([
      { address: "203.0.113.10", family: 4 },
    ]);
    stubFetch({ status: 200, contentType: "text/html", body: Buffer.from("hello") });
    await expect(fetchUrlImage("https://images.example.com/x")).rejects.toMatchObject({
      status: 415,
    });
  });

  it("propagates HTTP error status", async () => {
    (dnsLookup as ReturnType<typeof vi.fn>).mockResolvedValue([
      { address: "203.0.113.10", family: 4 },
    ]);
    stubFetch({ status: 404 });
    await expect(fetchUrlImage("https://images.example.com/x")).rejects.toMatchObject({
      status: 400,
    });
  });
});
