import type { APIRequestContext } from "@playwright/test";

/**
 * True when the server under test runs the keyless public demo
 * (LABEL_VERIFY_LIVE_MODELS unset). Live-model specs skip themselves in
 * that mode; offline-demo.spec.ts covers it instead.
 */
export async function isOfflineDemo(request: APIRequestContext): Promise<boolean> {
  const res = await request.get("/api/health");
  if (!res.ok()) return false;
  const body = (await res.json()) as { mode?: string };
  return body.mode === "offline-demo";
}
