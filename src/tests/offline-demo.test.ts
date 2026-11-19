import { readFileSync } from "node:fs";
import path from "node:path";
import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// ─── Keyless public demo (owner decision 2026-11-08) ───────────────────────
//
// With LABEL_VERIFY_LIVE_MODELS unset, the server must make no model call
// and read no provider key, even when keys are present in the environment.
// Every provider SDK constructor below throws, and global fetch throws, so
// any attempt to reach a provider fails the test.

const sdkCalls: string[] = [];
vi.mock("@google/generative-ai", () => ({
  GoogleGenerativeAI: class {
    constructor() {
      sdkCalls.push("google");
      throw new Error("Gemini SDK must not be constructed in offline demo");
    }
  },
  SchemaType: new Proxy({}, { get: (_t, k) => String(k) }),
}));
vi.mock("openai", () => ({
  default: class {
    constructor() {
      sdkCalls.push("openai");
      throw new Error("OpenAI SDK must not be constructed in offline demo");
    }
  },
}));
vi.mock("@anthropic-ai/sdk", () => ({
  default: class {
    constructor() {
      sdkCalls.push("anthropic");
      throw new Error("Anthropic SDK must not be constructed in offline demo");
    }
  },
}));

// Hermetic OCR: no WASM worker, no traineddata download.
vi.mock("@/lib/ocr/tesseract", () => ({
  tesseractEngine: {
    id: "tesseract",
    run: async () => ({ text: "", words: [], confidence: 0, latencyMs: 0, engine: "tesseract" }),
  },
  warmupTesseract: async () => undefined,
}));

import { POST as verifyPOST } from "@/app/api/verify/route";
import { POST as extractPOST } from "@/app/api/extract/route";
import { POST as batchPOST } from "@/app/api/verify/batch/route";
import { POST as appParsePOST } from "@/app/api/application/parse/route";
import { GET as healthGET } from "@/app/api/health/route";
import { GET as warmupGET } from "@/app/api/warmup/route";
import {
  LIVE_MODELS_ENV,
  OFFLINE_DEMO_CODE,
  liveModelsEnabled,
  providerEnv,
  providerKey,
} from "@/lib/demo-mode";
import { SAMPLES } from "@/lib/samples";
import type { VerifyResponse } from "@/lib/types";
import { tesseractEngine } from "@/lib/ocr/tesseract";

const FAKE_KEYS = {
  GOOGLE_API_KEY: "test-google-key-not-real",
  OPENAI_API_KEY: "test-openai-key-not-real",
  ANTHROPIC_API_KEY: "test-anthropic-key-not-real",
  OPENROUTER_API_KEY: "test-openrouter-key-not-real",
};

const savedEnv = { ...process.env };
const realFetch = globalThis.fetch;
let ipCounter = 0;

beforeEach(() => {
  delete process.env[LIVE_MODELS_ENV];
  Object.assign(process.env, FAKE_KEYS);
  sdkCalls.length = 0;
  globalThis.fetch = vi.fn(async () => {
    throw new Error("no network allowed in offline demo");
  }) as typeof fetch;
});

afterEach(() => {
  globalThis.fetch = realFetch;
  vi.restoreAllMocks();
  vi.unstubAllEnvs();
});

afterAll(() => {
  for (const k of Object.keys(process.env)) {
    if (!(k in savedEnv)) delete process.env[k];
  }
  Object.assign(process.env, savedEnv);
});

function firstSample() {
  const s = SAMPLES[0];
  if (!s) throw new Error("no bundled samples");
  return s;
}

function sampleImage(file: string): File {
  const bytes = readFileSync(path.join(process.cwd(), "public", file));
  return new File([bytes], path.basename(file), { type: "image/jpeg" });
}

function req(url: string, body: FormData | string, contentType?: string): Request {
  ipCounter += 1;
  const headers: Record<string, string> = { "x-forwarded-for": `10.9.0.${ipCounter}` };
  if (contentType) headers["content-type"] = contentType;
  return new Request(url, { method: "POST", body, headers });
}

describe("demo-mode helpers", () => {
  it("defaults to offline and hides provider keys", () => {
    const env = { ...FAKE_KEYS };
    expect(liveModelsEnabled(env)).toBe(false);
    expect(providerKey("GOOGLE_API_KEY", env)).toBeUndefined();
    expect(providerEnv(env).GOOGLE_API_KEY).toBeUndefined();
    expect(providerEnv(env).OPENAI_API_KEY).toBeUndefined();
  });

  it("only an exact server-side opt-in enables live models", () => {
    expect(liveModelsEnabled({ [LIVE_MODELS_ENV]: "true" })).toBe(false);
    expect(liveModelsEnabled({ [LIVE_MODELS_ENV]: "0" })).toBe(false);
    const env = { ...FAKE_KEYS, [LIVE_MODELS_ENV]: "1" };
    expect(liveModelsEnabled(env)).toBe(true);
    expect(providerKey("GOOGLE_API_KEY", env)).toBe(FAKE_KEYS.GOOGLE_API_KEY);
  });
});

describe("offline demo /api/verify", () => {
  // Recorded OCR word boxes from the shared PASS and REVIEW image.
  const warningWords = ([
    ["OVERNMENT", 253, 1374, 208, 86],
    ["WARNING:", 475, 1395, 185, 41],
    ["According", 731, 1399, 156, 43],
    ["cE", 253, 1438, 104, 73],
    ["women", 370, 1451, 106, 33],
    ["should", 493, 1451, 109, 38],
  ] as const).map(([text, x, y, width, height]) => ({
    text,
    bbox: { x, y, width, height },
    confidence: 0.9,
  }));
  const framings: { name: string; headers: Record<string, string>; stream: boolean }[] = [
    { name: "Content-Length: 0", headers: { "content-length": "0" }, stream: false },
    { name: "a body stream with no Content-Length", headers: {}, stream: true },
    { name: "Transfer-Encoding: chunked", headers: { "transfer-encoding": "chunked" }, stream: true },
  ];

  for (const sample of SAMPLES) {
    it.each(framings)(`${sample.id} sample returns its verdict with $name`, async ({ headers, stream }) => {
      if (sample.id !== "fail") {
        vi.stubEnv("LV_ENLARGE", "1");
        vi.stubEnv("LV_MAX_EDGE", "2000");
        vi.spyOn(tesseractEngine, "run").mockResolvedValue({
          text: "",
          words: warningWords,
          confidence: 0.9,
          latencyMs: 0,
          engine: "tesseract",
        });
      }
      const pull = vi.fn((controller: ReadableStreamDefaultController<Uint8Array>) => {
        controller.enqueue(new Uint8Array([1, 2, 3]));
        controller.close();
      });
      const init: RequestInit & { duplex: "half" } = {
        method: "POST",
        headers,
        body: stream ? new ReadableStream({ pull }, { highWaterMark: 0 }) : null,
        duplex: "half",
      };
      const request = new Request(
        `http://localhost/api/verify?sample=${sample.id}`,
        init,
      );
      const res = await verifyPOST(request);
      expect(request.bodyUsed).toBe(false);
      expect(pull).not.toHaveBeenCalled();
      expect(res.status).toBe(200);
      expect(res.headers.get("x-request-id")).toBeTruthy();
      expect(res.headers.get("x-label-verify-mode")).toBe("offline-demo");
      const body = (await res.json()) as VerifyResponse;
      expect(body.verdict).toBe(sample.expectedVerdict);
      const nonPass = Object.values(body.fields).filter((f) => f.status !== "pass").map((f) => f.field);
      expect(nonPass).toEqual(sample.id === "review" ? ["class_type"] : []);
      if (sample.id === "fail") expect(body.governmentWarning.subscores.caps.status).toBe("fail");
      expect(body.offlineDemo?.sampleId).toBe(sample.id);
      expect(body.offlineDemo?.note).toMatch(/No AI model was called/);
      expect(body.modelId).toBe("offline-sample-fixture");
      expect(body.secondOpinion).toBeUndefined();
      expect(body.fallbackUsed).toBeUndefined();
      expect(sdkCalls).toEqual([]);
      expect(globalThis.fetch).not.toHaveBeenCalled();
    });
  }

  it.each(["/api/verify", "/api/verify?sample=unknown"])("rejects an upload to %s without reading the body", async (route) => {
    const fd = new FormData();
    fd.append("image", sampleImage("/samples/pass.jpg"));
    const request = req(`http://localhost${route}`, fd);
    const res = await verifyPOST(request);
    expect(res.status).toBe(503);
    expect(res.headers.get("x-request-id")).toBeTruthy();
    expect(await res.json()).toMatchObject({ code: OFFLINE_DEMO_CODE });
    expect(request.bodyUsed).toBe(false);
  });

  it("runs the bundled sample without reading an attached file", async () => {
    const fd = new FormData();
    fd.append("image", new File(["tiny"], "label.png", { type: "image/png" }));
    const request = req("http://localhost/api/verify?sample=fail", fd);
    const res = await verifyPOST(request);
    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({
      verdict: "fail",
      offlineDemo: { sampleId: "fail" },
    });
    expect(request.bodyUsed).toBe(false);
  });

  it("refuses an unknown sample without a body", async () => {
    const request = new Request("http://localhost/api/verify?sample=unknown", {
      method: "POST",
    });
    const res = await verifyPOST(request);
    expect(res.status).toBe(503);
  });

  it("rejects URL verification with 503 and never fetches", async () => {
    const res = await verifyPOST(
      req(
        "http://localhost/api/verify",
        JSON.stringify({ url: "https://example.com/x.jpg", declared: firstSample().declared }),
        "application/json",
      ),
    );
    expect(res.status).toBe(503);
    expect(globalThis.fetch).not.toHaveBeenCalled();
  });
});

describe("offline demo: other model-backed routes", () => {
  it("extract-only returns 503", async () => {
    const fd = new FormData();
    fd.append("image", sampleImage("/samples/pass.jpg"));
    const res = await extractPOST(req("http://localhost/api/extract", fd));
    expect(res.status).toBe(503);
    expect(((await res.json()) as { code: string }).code).toBe(OFFLINE_DEMO_CODE);
  });

  it("batch returns 503", async () => {
    const fd = new FormData();
    fd.append("images", sampleImage("/samples/pass.jpg"));
    const res = await batchPOST(req("http://localhost/api/verify/batch", fd));
    expect(res.status).toBe(503);
  });

  it("application document parsing returns 503 without reading the body", async () => {
    const fd = new FormData();
    fd.append(
      "file",
      new File([JSON.stringify({ brand_name: "Visitor Brand" })], "app.json", {
        type: "application/json",
      }),
    );
    const request = req("http://localhost/api/application/parse", fd);
    const res = await appParsePOST(request);
    expect(res.status).toBe(503);
    expect(((await res.json()) as { code: string }).code).toBe(OFFLINE_DEMO_CODE);
    expect(request.bodyUsed).toBe(false);
  });

  it("photo-of-application parsing returns 503", async () => {
    const fd = new FormData();
    fd.append("file", sampleImage("/samples/pass.jpg"));
    const res = await appParsePOST(req("http://localhost/api/application/parse", fd));
    expect(res.status).toBe(503);
    expect(sdkCalls).toEqual([]);
  });

  it("health reports offline-demo mode and ready without exposing providers", async () => {
    const res = await healthGET(new Request("http://localhost/api/health"));
    const body = (await res.json()) as Record<string, unknown>;
    expect(body).toMatchObject({ ok: true, ready: true, mode: "offline-demo", notes: [] });
    expect(body).not.toHaveProperty("providers");
  });

  it("warmup never constructs a provider client", async () => {
    const res = await warmupGET();
    const body = (await res.json()) as { gemini: string };
    expect(body.gemini).toBe("offline-demo");
    expect(sdkCalls).toEqual([]);
  });
});
