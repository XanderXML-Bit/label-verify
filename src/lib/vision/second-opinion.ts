// Second-opinion extractor selector.
//
// The "second-opinion" path is the borderline-Gov-Warning recheck:
// when the primary call lands in REVIEW (or PASS with low confidence
// and no OCR corroboration), we fire ONE additional vision call
// against an independent model to corroborate or refute the primary
// read. See src/lib/verify.ts §6 for the trigger conditions.
//
// This is a separate concern from the primary-fails FALLBACK path
// (see verify.ts §2): the fallback exists for provider-diversity
// when the primary is completely unreachable / 5xx / aborted.
// Cross-provider diversity matters there because the primary's
// FAILURE is the trigger, so the fallback must live on a different
// network/auth/quota footprint. The second-opinion's trigger is the
// primary's UNCERTAINTY, so what matters is independence of the
// reasoning, not the provider.
//
// Wave-22 (2026-05-13): per user direction, the default second-opinion
// model is now Gemini 2.5 Flash (smarter than the primary Flash-Lite
// at the same price tier) instead of GPT-5.4-nano. The OpenAI nano
// path remains available via SECOND_OPINION_PROVIDER=openai for A/B
// comparison.
//
// Env var contract:
//   SECOND_OPINION_PROVIDER ∈ {"gemini", "openai"}        (default: "gemini")
//   SECOND_OPINION_MODEL    ∈ any model id valid for provider
//     - gemini: defaults to "gemini-2.5-flash" (the GeminiFlashFullExtractor default)
//     - openai: defaults to MODEL_FALLBACK ?? "gpt-5.4-nano" for back-compat
//
// Returns null when no provider key is available — the caller treats
// that as "second-opinion unavailable" and ships the primary verdict
// alone (same behavior as the pre-wave-22 OPENAI_API_KEY-absent path).

import type { Extractor } from "./types";
import { GeminiFlashFullExtractor } from "./gemini";

type Provider = "gemini" | "openai";

// Compatible with `process.env` (NodeJS.ProcessEnv has an open index
// signature). Accepting a wider shape than a named interface lets
// callers pass `process.env` directly without a cast, while still
// documenting the variables we care about.
export type SecondOpinionEnv = {
  GOOGLE_API_KEY?: string;
  OPENAI_API_KEY?: string;
  SECOND_OPINION_PROVIDER?: string;
  SECOND_OPINION_MODEL?: string;
  /** Legacy variable, kept as the OpenAI default for back-compat with pre-wave-22 setups. */
  MODEL_FALLBACK?: string;
} & Record<string, string | undefined>;

/**
 * Build the second-opinion extractor based on environment variables.
 *
 * Resolution order:
 *   1. If SECOND_OPINION_PROVIDER is explicitly set, honor it. Returns
 *      null if the corresponding key is missing (no silent provider
 *      switch — operator asked for X, they get X or nothing).
 *   2. Otherwise default to Gemini if GOOGLE_API_KEY is set; otherwise
 *      try OpenAI; otherwise return null.
 *
 * Tests mock this module via vi.mock("@/lib/vision/second-opinion")
 * to inject deterministic extractors without needing real keys.
 */
export async function buildSecondOpinionExtractor(
  env: SecondOpinionEnv,
): Promise<Extractor | null> {
  const explicit = (env.SECOND_OPINION_PROVIDER ?? "").toLowerCase().trim();

  let provider: Provider | null = null;
  if (explicit === "gemini" || explicit === "openai") {
    provider = explicit as Provider;
  } else if (env.GOOGLE_API_KEY) {
    provider = "gemini";
  } else if (env.OPENAI_API_KEY) {
    provider = "openai";
  }

  if (provider === "gemini") {
    if (!env.GOOGLE_API_KEY) return null;
    return new GeminiFlashFullExtractor({
      apiKey: env.GOOGLE_API_KEY,
      modelVersion: env.SECOND_OPINION_MODEL, // undefined → adapter default (gemini-2.5-flash)
    });
  }

  if (provider === "openai") {
    if (!env.OPENAI_API_KEY) return null;
    // Lazy import: keeps OpenAI SDK out of the cold-start path for
    // deployments that only ever exercise the Gemini second-opinion.
    const mod = await import("./openai");
    return new mod.GPT4oMiniExtractor({
      apiKey: env.OPENAI_API_KEY,
      modelVersion: env.SECOND_OPINION_MODEL ?? env.MODEL_FALLBACK,
    });
  }

  return null;
}

/**
 * Single source of truth for "is a second-opinion provider configured?".
 * The orchestrator uses this in its trigger predicate so we don't fire
 * the borderline-recheck path only to find no key is available.
 */
export function secondOpinionAvailable(env: SecondOpinionEnv): boolean {
  const explicit = (env.SECOND_OPINION_PROVIDER ?? "").toLowerCase().trim();
  if (explicit === "gemini") return !!env.GOOGLE_API_KEY;
  if (explicit === "openai") return !!env.OPENAI_API_KEY;
  return !!env.GOOGLE_API_KEY || !!env.OPENAI_API_KEY;
}
