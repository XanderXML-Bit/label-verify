import { describe, it, expect } from "vitest";
import {
  buildSecondOpinionExtractor,
  secondOpinionAvailable,
  type SecondOpinionEnv,
} from "@/lib/vision/second-opinion";

// We don't want to import OpenAI/Gemini SDKs in this unit test — we
// only care that the resolver wires the right env values to the right
// adapter. The adapter classes themselves are exercised by their own
// integration tests. We assert via `.constructor.name` and the
// `.modelVersion` property which both adapters expose identically.

describe("buildSecondOpinionExtractor", () => {
  it("defaults to Gemini 2.5 Flash when GOOGLE_API_KEY is set", async () => {
    const env: SecondOpinionEnv = { GOOGLE_API_KEY: "test-gemini-key" };
    const ext = await buildSecondOpinionExtractor(env);
    expect(ext).not.toBeNull();
    expect(ext!.id).toMatch(/^gemini:/);
    // Adapter default
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    expect((ext as any).modelVersion).toBe("gemini-2.5-flash");
  });

  it("honors SECOND_OPINION_MODEL override on the Gemini path", async () => {
    const env: SecondOpinionEnv = {
      GOOGLE_API_KEY: "test-gemini-key",
      SECOND_OPINION_MODEL: "gemini-3.1-flash-lite",
    };
    const ext = await buildSecondOpinionExtractor(env);
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    expect((ext as any).modelVersion).toBe("gemini-3.1-flash-lite");
  });

  it("switches to OpenAI when SECOND_OPINION_PROVIDER=openai", async () => {
    const env: SecondOpinionEnv = {
      GOOGLE_API_KEY: "should-be-ignored",
      OPENAI_API_KEY: "test-openai-key",
      SECOND_OPINION_PROVIDER: "openai",
    };
    const ext = await buildSecondOpinionExtractor(env);
    expect(ext).not.toBeNull();
    expect(ext!.id).toMatch(/^openai:/);
  });

  it("falls back to OpenAI when GOOGLE_API_KEY is missing but OPENAI_API_KEY is set", async () => {
    const env: SecondOpinionEnv = { OPENAI_API_KEY: "test-openai-key" };
    const ext = await buildSecondOpinionExtractor(env);
    expect(ext).not.toBeNull();
    expect(ext!.id).toMatch(/^openai:/);
  });

  it("uses MODEL_FALLBACK as the OpenAI default for back-compat", async () => {
    const env: SecondOpinionEnv = {
      OPENAI_API_KEY: "test-openai-key",
      MODEL_FALLBACK: "gpt-4o-mini",
    };
    const ext = await buildSecondOpinionExtractor(env);
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    expect((ext as any).modelVersion).toBe("gpt-4o-mini");
  });

  it("returns null when no key is available at all", async () => {
    const ext = await buildSecondOpinionExtractor({});
    expect(ext).toBeNull();
  });

  it("returns null when SECOND_OPINION_PROVIDER asks for openai but no OPENAI_API_KEY is set", async () => {
    // Even with a Gemini key, the explicit operator choice should not
    // be silently overridden — better to ship no second-opinion than
    // to fire the wrong model.
    const env: SecondOpinionEnv = {
      GOOGLE_API_KEY: "test-gemini-key",
      SECOND_OPINION_PROVIDER: "openai",
    };
    const ext = await buildSecondOpinionExtractor(env);
    expect(ext).toBeNull();
  });

  it("returns null when SECOND_OPINION_PROVIDER asks for gemini but no GOOGLE_API_KEY is set", async () => {
    const env: SecondOpinionEnv = {
      OPENAI_API_KEY: "test-openai-key",
      SECOND_OPINION_PROVIDER: "gemini",
    };
    const ext = await buildSecondOpinionExtractor(env);
    expect(ext).toBeNull();
  });
});

describe("secondOpinionAvailable", () => {
  it("returns true when any key is present (default routing)", () => {
    expect(secondOpinionAvailable({ GOOGLE_API_KEY: "x" })).toBe(true);
    expect(secondOpinionAvailable({ OPENAI_API_KEY: "x" })).toBe(true);
    expect(secondOpinionAvailable({})).toBe(false);
  });

  it("respects explicit provider gating", () => {
    expect(
      secondOpinionAvailable({
        SECOND_OPINION_PROVIDER: "openai",
        GOOGLE_API_KEY: "x",
      }),
    ).toBe(false);
    expect(
      secondOpinionAvailable({
        SECOND_OPINION_PROVIDER: "gemini",
        OPENAI_API_KEY: "x",
      }),
    ).toBe(false);
  });
});
