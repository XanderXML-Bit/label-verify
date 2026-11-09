// Public-demo key policy (owner decision 2026-11-08).
//
// The public deployment uses NO model-provider API keys. Every server
// read of a provider key goes through `providerKey()` / `providerEnv()`
// below, and both return nothing unless the operator explicitly opts in
// with LABEL_VERIFY_LIVE_MODELS=1 in the SERVER environment. That makes
// "offline demo" the default even if a key is still present in the
// hosting environment: no Gemini / OpenAI / Anthropic / OpenRouter
// client is ever constructed, so no outbound model call can happen.
//
// Keys are never exposed to the browser: none of these variables use the
// NEXT_PUBLIC_ prefix, and this module is imported only from server code
// (route handlers and `src/lib/verify.ts`).
//
// In offline mode the bundled samples still run end to end. The vision
// step is replaced by a recorded, clearly labelled sample extraction
// (`src/lib/vision/offline-sample.ts`); preprocessing, OCR, the field
// comparators and the Government Warning validator run for real.
// Uploaded images are ignored (the bundled sample image is read from
// disk). Uploads without a sample id, URL fetches, extract-only, batch
// and photo-of-application parsing return HTTP 503 `code: "offline-demo"`.
//
// The page is prerendered, so the UI mode is fixed at build time: change
// LABEL_VERIFY_LIVE_MODELS and redeploy.

import { OFFLINE_DEMO_CODE, OFFLINE_DEMO_MESSAGE } from "./demo-copy";

export const LIVE_MODELS_ENV = "LABEL_VERIFY_LIVE_MODELS";

export const PROVIDER_KEY_NAMES = [
  "GOOGLE_API_KEY",
  "OPENAI_API_KEY",
  "ANTHROPIC_API_KEY",
  "OPENROUTER_API_KEY",
] as const;

export type ProviderKeyName = (typeof PROVIDER_KEY_NAMES)[number];

type Env = Record<string, string | undefined>;

/** True only when the operator explicitly enabled live model calls. */
export function liveModelsEnabled(env: Env = process.env): boolean {
  return (env[LIVE_MODELS_ENV] ?? "").trim() === "1";
}

/**
 * Provider key lookup. Returns undefined in offline-demo mode, whatever
 * the environment contains.
 */
export function providerKey(
  name: ProviderKeyName,
  env: Env = process.env,
): string | undefined {
  if (!liveModelsEnabled(env)) return undefined;
  const value = env[name];
  return value ? value : undefined;
}

/**
 * Copy of the environment with every provider key removed when live
 * models are off. Used by helpers that take an env object (second
 * opinion selection).
 */
export function providerEnv(env: Env = process.env): Env {
  if (liveModelsEnabled(env)) return env;
  const copy: Env = { ...env };
  for (const name of PROVIDER_KEY_NAMES) delete copy[name];
  return copy;
}

export { OFFLINE_DEMO_CODE, OFFLINE_DEMO_MESSAGE, OFFLINE_SAMPLE_NOTE } from "./demo-copy";

/** Standard 503 body for model-backed routes in offline-demo mode. */
export function offlineDemoBody(): { error: string; code: string; offlineDemo: true } {
  return { error: OFFLINE_DEMO_MESSAGE, code: OFFLINE_DEMO_CODE, offlineDemo: true };
}
