// Per-call cost approximation by model id.
//
// Wave-35 Track 1 #2 (audit cleanup): this table used to live in
// `src/app/components/SingleResult.tsx`, but the client-side copy
// drifted from the server's knowledge of which model actually ran.
// The server already knows the model id (it owns the extractor
// selection) — so the cost is now computed server-side and shipped
// on `VerifyResponse.costUsd`. The component just reads the field.
//
// Refreshed from `benchmarks/results/<latest>.md` columns "USD /
// call". Sub-penny entries are intentional — the per-1k extrapolation
// is what TTB ops procurement actually quotes against.
//
// `null` return signals "unknown model" (or the env stripped the
// envelope) and the UI must render gracefully without a cost line.

const COST_PER_CALL_BY_MODEL: Record<string, number> = {
  "gemini:gemini-3.1-flash-lite": 0.00025,
  "gemini:gemini-3-flash-preview": 0.00243,
  "gemini:gemini-3.1-pro-preview": 0.00345,
  "gemini:gemini-2.5-flash": 0.00243,
  "openai:gpt-5.4-nano": 0.00125,
  "openai:gpt-4o-mini": 0.00045,
};

/**
 * Best-effort per-call cost lookup. Returns the exact entry when the
 * model id is known, falls back to provider-prefix defaults for
 * unknown sub-revisions of a known vendor, and returns `null` when
 * we can't say anything useful.
 */
export function approximateCostUsd(modelId: string | undefined): number | null {
  if (!modelId) return null;
  const direct = COST_PER_CALL_BY_MODEL[modelId];
  if (typeof direct === "number") return direct;
  // Provider-prefix fallback: "gemini:..." → cheapest flash-lite,
  // "openai:..." → gpt-5.4-nano cost band. These match the actual
  // model that production rotates to when the requested model isn't
  // available (see `src/lib/vision/index.ts` resolver), so the
  // fallback is the same cost the system actually pays.
  if (modelId.startsWith("gemini:")) return 0.00025;
  if (modelId.startsWith("openai:")) return 0.00125;
  return null;
}
