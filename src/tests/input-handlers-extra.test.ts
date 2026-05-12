import { describe, expect, it, vi, beforeEach, afterEach } from "vitest";
import { UrlFetchError, fetchUrlImage } from "@/lib/input-handlers";

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

interface ResponseSpec {
  status?: number;
  body?: Buffer;
  contentType?: string;
  location?: string;
}

/**
 * Build a `fetch` stub that walks through a series of canned responses, one
 * per call. Useful for redirect-chain tests where each hop returns a
 * different status.
 */
function stubFetchSequence(specs: ResponseSpec[]): ReturnType<typeof vi.fn> {
  const queue = [...specs];
  const fn = vi.fn().mockImplementation(async () => {
    const spec = queue.shift() ?? { status: 500 };
    const status = spec.status ?? 200;
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
  });
  globalThis.fetch = fn as typeof fetch;
  return fn;
}

describe("fetchUrlImage — schemes", () => {
  it("rejects ftp:// with status 400", async () => {
    await expect(fetchUrlImage("ftp://example.com/x.png")).rejects.toMatchObject({
      status: 400,
    });
  });

  it("rejects gopher:// with status 400", async () => {
    await expect(fetchUrlImage("gopher://example.com/x")).rejects.toMatchObject({
      status: 400,
    });
  });

  it("accepts both http:// and https:// (smoke)", async () => {
    (dnsLookup as ReturnType<typeof vi.fn>).mockResolvedValue([
      { address: "203.0.113.10", family: 4 },
    ]);
    stubFetchSequence([
      { status: 200, contentType: "image/png", body: Buffer.from([0x89, 0x50]) },
    ]);
    const a = await fetchUrlImage("https://images.example.com/x.png");
    expect(a.finalUrl).toMatch(/^https:/);

    (dnsLookup as ReturnType<typeof vi.fn>).mockResolvedValue([
      { address: "203.0.113.11", family: 4 },
    ]);
    stubFetchSequence([
      { status: 200, contentType: "image/png", body: Buffer.from([0x89, 0x50]) },
    ]);
    const b = await fetchUrlImage("http://images.example.com/x.png");
    expect(b.finalUrl).toMatch(/^http:/);
  });
});

describe("fetchUrlImage — redirects", () => {
  it("follows a single redirect to a public host and returns the body", async () => {
    (dnsLookup as ReturnType<typeof vi.fn>).mockResolvedValue([
      { address: "203.0.113.10", family: 4 },
    ]);
    const fetchFn = stubFetchSequence([
      { status: 302, location: "https://cdn.example.com/x.png" },
      {
        status: 200,
        contentType: "image/png",
        body: Buffer.from([0x89, 0x50, 0x4e, 0x47]),
      },
    ]);
    const result = await fetchUrlImage("https://images.example.com/x");
    expect(result.mime).toBe("image/png");
    expect(fetchFn).toHaveBeenCalledTimes(2);
  });

  it("re-runs the SSRF guard on a redirect that points at a private IP", async () => {
    // Hop 1 resolves to a public IP, hop 2's hostname resolves to a private
    // one. The guard must trip on hop 2's lookup, not silently follow.
    const lookup = dnsLookup as ReturnType<typeof vi.fn>;
    lookup
      .mockResolvedValueOnce([{ address: "203.0.113.10", family: 4 }])
      .mockResolvedValueOnce([{ address: "10.0.0.5", family: 4 }]);
    stubFetchSequence([
      { status: 302, location: "https://internal.example.com/x.png" },
    ]);
    await expect(
      fetchUrlImage("https://public.example.com/x"),
    ).rejects.toMatchObject({ status: 400 });
  });

  it("rejects a redirect with no Location header (502)", async () => {
    (dnsLookup as ReturnType<typeof vi.fn>).mockResolvedValue([
      { address: "203.0.113.10", family: 4 },
    ]);
    stubFetchSequence([{ status: 302 /* no location */ }]);
    await expect(
      fetchUrlImage("https://images.example.com/x"),
    ).rejects.toMatchObject({ status: 502 });
  });

  it("exceeds the redirect limit and throws UrlFetchError", async () => {
    (dnsLookup as ReturnType<typeof vi.fn>).mockResolvedValue([
      { address: "203.0.113.10", family: 4 },
    ]);
    // 5 hops all returning 302 — the limit is 3.
    stubFetchSequence([
      { status: 302, location: "https://a.example.com/" },
      { status: 302, location: "https://b.example.com/" },
      { status: 302, location: "https://c.example.com/" },
      { status: 302, location: "https://d.example.com/" },
      { status: 302, location: "https://e.example.com/" },
    ]);
    await expect(
      fetchUrlImage("https://images.example.com/x"),
    ).rejects.toBeInstanceOf(UrlFetchError);
  });
});

describe("fetchUrlImage — DNS + remote errors", () => {
  it("DNS lookup failure maps to UrlFetchError (status 400)", async () => {
    (dnsLookup as ReturnType<typeof vi.fn>).mockRejectedValue(
      new Error("ENOTFOUND no-such-host.example"),
    );
    await expect(
      fetchUrlImage("https://no-such-host.example/x"),
    ).rejects.toMatchObject({ status: 400 });
  });

  it("5xx response maps to status 502 (gateway-ish)", async () => {
    (dnsLookup as ReturnType<typeof vi.fn>).mockResolvedValue([
      { address: "203.0.113.10", family: 4 },
    ]);
    stubFetchSequence([{ status: 503 }]);
    await expect(
      fetchUrlImage("https://images.example.com/x"),
    ).rejects.toMatchObject({ status: 502 });
  });

  it("fetch network error maps to status 502", async () => {
    (dnsLookup as ReturnType<typeof vi.fn>).mockResolvedValue([
      { address: "203.0.113.10", family: 4 },
    ]);
    globalThis.fetch = vi.fn().mockRejectedValue(
      Object.assign(new Error("connection reset"), { name: "TypeError" }),
    ) as typeof fetch;
    await expect(
      fetchUrlImage("https://images.example.com/x"),
    ).rejects.toMatchObject({ status: 502 });
  });
});
