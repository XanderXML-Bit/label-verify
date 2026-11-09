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
  for (const sample of SAMPLES) {
    it(`${sample.id} sample returns its expected verdict with no model call`, async () => {
      const fd = new FormData();
      fd.append("image", sampleImage(sample.imageUrl));
      // Declared data from the client is ignored; the bundled sample wins.
      fd.append("declared", JSON.stringify({ brand_name: "Tampered" }));
      fd.append("sample", sample.id);
      const res = await verifyPOST(req("http://localhost/api/verify", fd));
      expect(res.status).toBe(200);
      expect(res.headers.get("x-label-verify-mode")).toBe("offline-demo");
      const body = (await res.json()) as VerifyResponse;
      // OCR is mocked out here, so the Government Warning bold subscore
      // falls back to the recorded self-report and the clean sample lands
      // on REVIEW instead of PASS (no second opinion offline). With real
      // Tesseract (next start) the three samples give PASS / FAIL / REVIEW;
      // see the PR evidence. Field comparisons are exact either way.
      const hermeticVerdict = { pass: "review", fail: "fail", review: "review" }[sample.id];
      expect(body.verdict).toBe(hermeticVerdict);
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

  it("rejects an arbitrary upload with 503 offline-demo", async () => {
    const fd = new FormData();
    fd.append("image", sampleImage("/samples/pass.jpg"));
    fd.append("declared", JSON.stringify(firstSample().declared));
    const res = await verifyPOST(req("http://localhost/api/verify", fd));
    expect(res.status).toBe(503);
    expect(((await res.json()) as { code: string }).code).toBe(OFFLINE_DEMO_CODE);
    expect(sdkCalls).toEqual([]);
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
