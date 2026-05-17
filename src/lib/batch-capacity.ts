// Batch capacity is constrained by the public Gemini interactive API quota and
// by the serverless SSE function duration. Rate limits are project-level, not
// per API key; active limits must be checked in AI Studio. With no local key or
// quota API available, this default follows the documented conservative Tier-1
// Gemini Flash-Lite floor: 30 RPM / 1M TPM / 1,500 RPD. We reserve 20% provider
// headroom plus 45s of the 300s stream window for cold starts, OCR tail latency,
// cleanup, and client disconnect handling.

export const DEFAULT_GEMINI_RPM_LIMIT = 30;
export const BATCH_STREAM_MAX_DURATION_SEC = 300;
export const BATCH_SAFETY_SECONDS = 45;
export const BATCH_PROVIDER_UTILIZATION = 0.8;
export const BATCH_HARD_CAP = 1000;

// Keep aggregate request memory materially below the 1024 MB Vercel allocation
// for the create route. `req.formData()` buffers and file.arrayBuffer() copies,
// so 1 GiB is not safe in a 1 GiB function. 256 MiB still supports the derived
// 100-label default with typical compressed label photos while failing closed on
// abusive/malformed uploads before parsing.
export const MAX_BATCH_BODY_BYTES = 256 * 1024 * 1024;

export function computeBatchCapacity(opts: {
  geminiRpm: number;
  streamMaxDurationSec: number;
  safetySeconds: number;
  utilization: number;
  maxHardCap: number;
}): number {
  const usableSeconds = Math.max(0, opts.streamMaxDurationSec - opts.safetySeconds);
  const safeRpm = Math.max(1, Math.floor(opts.geminiRpm * opts.utilization));
  const capacity = Math.floor((safeRpm * usableSeconds) / 60);
  // Round down to a reviewer-friendly number so docs/UI do not imply false
  // precision from quota math.
  const rounded = Math.floor(capacity / 25) * 25;
  return Math.max(1, Math.min(opts.maxHardCap, rounded));
}

function positiveIntFromEnv(name: string): number | null {
  const raw = process.env[name];
  if (!raw) return null;
  const n = Number(raw);
  return Number.isInteger(n) && n > 0 ? n : null;
}

export function configuredGeminiRpmLimit(): number {
  return positiveIntFromEnv("GEMINI_RPM_LIMIT") ?? DEFAULT_GEMINI_RPM_LIMIT;
}

/**
 * Wave-33 audit (Sub-agent B finding #8): `.env.example` documents
 * `MAX_BATCH_SIZE` as the hard ceiling but the previous version of
 * this module hardcoded the cap. Now properly env-overridable: when
 * `MAX_BATCH_SIZE` is set to a positive integer, it overrides
 * `BATCH_HARD_CAP`. Capped at 5000 defensively to keep memory bounded.
 */
export function configuredMaxBatchHardCap(): number {
  const fromEnv = positiveIntFromEnv("MAX_BATCH_SIZE");
  if (fromEnv === null) return BATCH_HARD_CAP;
  return Math.min(5000, fromEnv);
}

export function configuredMaxBatchItems(): number {
  return computeBatchCapacity({
    geminiRpm: configuredGeminiRpmLimit(),
    streamMaxDurationSec: BATCH_STREAM_MAX_DURATION_SEC,
    safetySeconds: BATCH_SAFETY_SECONDS,
    utilization: BATCH_PROVIDER_UTILIZATION,
    maxHardCap: configuredMaxBatchHardCap(),
  });
}

export const DEFAULT_MAX_BATCH_ITEMS = computeBatchCapacity({
  geminiRpm: DEFAULT_GEMINI_RPM_LIMIT,
  streamMaxDurationSec: BATCH_STREAM_MAX_DURATION_SEC,
  safetySeconds: BATCH_SAFETY_SECONDS,
  utilization: BATCH_PROVIDER_UTILIZATION,
  maxHardCap: BATCH_HARD_CAP,
});
