// Wave-35g (follow-on) — coverage on the still-uncovered branches of
// /api/application/parse.
//
// The existing api-application-parse-happy.test.ts pins the
// structured-format happy paths (JSON, CSV, markdown, plain-text)
// plus the basic 400/413s. This file pins the remaining branches:
//
//   • The image-of-application vision path:
//       — 503 when GOOGLE_API_KEY is unset (vision-unavailable)
//       — 200 + source='image-vision' on success
//       — 502 when parseApplicationImage throws
//   • parseApplication ApplicationParseError → uses error.status
//   • parseApplication generic throw → 500
//   • req.formData() failure → 400 (bad-request)
//
// Mocks @/lib/application/parse-image so the image-vision branch
// can be exercised without a real Gemini call.

import { describe, expect, it, vi, beforeEach, afterEach } from "vitest";

const parseApplicationImageMock = vi.fn();
vi.mock("@/lib/application/parse-image", () => ({
  parseApplicationImage: (...args: unknown[]) =>
    parseApplicationImageMock(...args),
}));

const parseApplicationMock = vi.fn();
vi.mock("@/lib/application/parse", async () => {
  // eslint-disable-next-line @typescript-eslint/consistent-type-imports -- vitest partial-mock pattern
  const actual = await vi.importActual<typeof import("@/lib/application/parse")>(
    "@/lib/application/parse",
  );
  return {
    ...actual,
    parseApplication: (...args: unknown[]) => parseApplicationMock(...args),
  };
});

import { POST } from "@/app/api/application/parse/route";
import { ApplicationParseError } from "@/lib/application/types";

let ipCounter = 9_000;
function freshIp(): string {
  ipCounter++;
  return `198.51.103.${ipCounter % 250}`;
}

function multipartReq(parts: {
  file?: { buffer: Buffer; type: string; name: string };
  imageFilename?: string;
}): Request {
  const fd = new FormData();
  if (parts.file) {
    const blob = new Blob([parts.file.buffer as unknown as BlobPart], {
      type: parts.file.type,
    });
    fd.append(
      "file",
      new File([blob], parts.file.name, { type: parts.file.type }),
    );
  }
  if (parts.imageFilename) {
    fd.append("imageFilename", parts.imageFilename);
  }
  return new Request("http://test.local/api/application/parse", {
    method: "POST",
    body: fd,
    headers: { "x-forwarded-for": freshIp() },
  });
}

beforeEach(() => {
  parseApplicationImageMock.mockReset();
  parseApplicationMock.mockReset();
});

afterEach(() => {
  vi.restoreAllMocks();
});

describe("/api/application/parse — image-of-application vision path", () => {
  it("returns 503 vision-unavailable when GOOGLE_API_KEY is unset", async () => {
    const prev = process.env.GOOGLE_API_KEY;
    delete process.env.GOOGLE_API_KEY;
    try {
      const resp = await POST(
        multipartReq({
          file: {
            buffer: Buffer.from([0xff, 0xd8, 0xff]),
            type: "image/jpeg",
            name: "app.jpg",
          },
        }),
      );
      expect(resp.status).toBe(503);
      const body = (await resp.json()) as { code: string; error: string };
      expect(body.code).toBe("vision-unavailable");
      expect(body.error).toMatch(/GOOGLE_API_KEY/);
    } finally {
      if (prev !== undefined) process.env.GOOGLE_API_KEY = prev;
    }
  });

  it("returns 200 + source='image-vision' on the happy path with a configured key", async () => {
    const prev = process.env.GOOGLE_API_KEY;
    process.env.GOOGLE_API_KEY = "test-key";
    try {
      parseApplicationImageMock.mockResolvedValueOnce({
        fields: { brand_name: "Stone IPA" },
        warnings: ["image-vision: confidence is intrinsically low"],
        modelUsed: "gemini-2.5-flash",
      });
      const resp = await POST(
        multipartReq({
          file: {
            buffer: Buffer.from([0xff, 0xd8, 0xff]),
            type: "image/jpeg",
            name: "app.jpg",
          },
        }),
      );
      expect(resp.status).toBe(200);
      const body = (await resp.json()) as {
        fields: Record<string, unknown>;
        source: string;
        confidence: string;
        warnings: string[];
      };
      expect(body.source).toBe("image-vision");
      expect(body.confidence).toBe("low");
      expect(body.fields.brand_name).toBe("Stone IPA");
      expect(body.warnings).toEqual(
        expect.arrayContaining([
          expect.stringMatching(/confidence is intrinsically low/),
        ]),
      );
    } finally {
      if (prev === undefined) {
        delete process.env.GOOGLE_API_KEY;
      } else {
        process.env.GOOGLE_API_KEY = prev;
      }
    }
  });

  it("returns 502 when parseApplicationImage throws (network / Gemini 5xx)", async () => {
    const prev = process.env.GOOGLE_API_KEY;
    process.env.GOOGLE_API_KEY = "test-key";
    try {
      parseApplicationImageMock.mockRejectedValueOnce(
        new Error("gemini 503"),
      );
      const resp = await POST(
        multipartReq({
          file: {
            buffer: Buffer.from([0xff, 0xd8, 0xff]),
            type: "image/jpeg",
            name: "app.jpg",
          },
        }),
      );
      expect(resp.status).toBe(502);
      const body = (await resp.json()) as { code: string; error: string };
      expect(body.code).toBe("parse-failed");
      expect(body.error).toMatch(/Image vision failed.*gemini 503/);
    } finally {
      if (prev === undefined) {
        delete process.env.GOOGLE_API_KEY;
      } else {
        process.env.GOOGLE_API_KEY = prev;
      }
    }
  });
});

describe("/api/application/parse — parseApplication error branches", () => {
  it("propagates ApplicationParseError's status (413 too-large)", async () => {
    parseApplicationMock.mockRejectedValueOnce(
      new ApplicationParseError(
        "too-large",
        "Internal parse cap exceeded.",
        413,
      ),
    );
    const resp = await POST(
      multipartReq({
        file: {
          buffer: Buffer.from(
            JSON.stringify({ brand_name: "X" }),
          ),
          type: "application/json",
          name: "app.json",
        },
      }),
    );
    expect(resp.status).toBe(413);
    const body = (await resp.json()) as { code: string };
    expect(body.code).toBe("too-large");
  });

  it("propagates ApplicationParseError's status (415 unsupported-mime)", async () => {
    parseApplicationMock.mockRejectedValueOnce(
      new ApplicationParseError(
        "unsupported-mime",
        "MIME type not supported.",
        415,
      ),
    );
    const resp = await POST(
      multipartReq({
        file: {
          buffer: Buffer.from("dummy"),
          type: "application/x-weird",
          name: "app.weird",
        },
      }),
    );
    expect(resp.status).toBe(415);
    const body = (await resp.json()) as { code: string };
    expect(body.code).toBe("unsupported-mime");
  });

  it("maps a generic (non-ApplicationParseError) throw to 500", async () => {
    parseApplicationMock.mockRejectedValueOnce(new Error("boom"));
    const resp = await POST(
      multipartReq({
        file: {
          buffer: Buffer.from(JSON.stringify({ brand_name: "X" })),
          type: "application/json",
          name: "app.json",
        },
      }),
    );
    expect(resp.status).toBe(500);
    const body = (await resp.json()) as { code: string; error: string };
    expect(body.code).toBe("parse-failed");
    expect(body.error).toMatch(/Application parse failed.*boom/);
  });
});

describe("/api/application/parse — body-shape guard", () => {
  it("returns 400 bad-request when req.formData() throws", async () => {
    // A body that's not multipart/form-data and not a parseable form
    // throws inside req.formData(). The route catches and 400s.
    const req = new Request("http://test.local/api/application/parse", {
      method: "POST",
      body: "not-form-data",
      headers: {
        "content-type": "text/plain",
        "x-forwarded-for": freshIp(),
      },
    });
    const resp = await POST(req);
    expect(resp.status).toBe(400);
    const body = (await resp.json()) as { code: string };
    expect(body.code).toBe("bad-request");
  });
});

describe("/api/application/parse — imageFilename hint passthrough", () => {
  it("forwards `imageFilename` form field to parseApplication", async () => {
    parseApplicationMock.mockResolvedValueOnce({
      fields: { brand_name: "X" },
      source: "csv",
      warnings: [],
      confidence: "high",
    });
    const csv =
      "filename,brand_name,class_type,class_category,abv_percent,net_contents,producer,country_of_origin\n" +
      `a.jpg,X,IPA,beer,6.4,12 fl_oz,Y,USA\n`;
    await POST(
      multipartReq({
        file: {
          buffer: Buffer.from(csv),
          type: "text/csv",
          name: "manifest.csv",
        },
        imageFilename: "a.jpg",
      }),
    );
    const callArg = parseApplicationMock.mock.calls[0]?.[0] as {
      imageFilename: string;
    };
    expect(callArg.imageFilename).toBe("a.jpg");
  });
});
