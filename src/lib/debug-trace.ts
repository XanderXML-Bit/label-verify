import type { DeclaredFields, VerifyResponse } from "./types";

// ─── VerifyTrace ────────────────────────────────────────────────────────────
//
// One captured pipeline run. The reviewer needs enough breadcrumbs to answer
// "why did this label fail for an odd reason?" without re-running the call:
// the declared inputs, the preprocessed dimensions (so they can spot a
// rotation / crop bug), the model identity + prompt hash (for reproducibility
// — see APPROACH.md §7), the raw OCR text, the raw extractor output, and the
// final VerifyResponse the user actually saw.

export interface VerifyTrace {
  id: string;
  receivedAt: number;
  declared: DeclaredFields;
  preprocessedDims: { w: number; h: number };
  modelId: string;
  modelVersion: string;
  promptHash: string;
  ocrText: string | null;
  rawExtraction: unknown;
  response: VerifyResponse;
}

// ─── In-memory ring buffer ──────────────────────────────────────────────────
//
// IMPORTANT: this store lives in module-scope memory. It is wiped on process
// restart (cold start on Vercel, server restart locally) and is *not* shared
// across serverless instances. That is the explicit prototype tradeoff
// recorded in DEPLOYMENT.md §7 — a real implementation would persist to a
// short-TTL KV store. For a reviewer poking at the most recent verification,
// the same-instance read is good enough.

const CAP = 20;
const buffer: VerifyTrace[] = [];

/** Append a trace, evicting the oldest beyond the {@link CAP} of 20. */
export function recordTrace(trace: VerifyTrace): void {
  buffer.push(trace);
  while (buffer.length > CAP) {
    buffer.shift();
  }
}

/**
 * Return up to `limit` traces, most-recent-first. Default returns the entire
 * buffer (≤ 20).
 */
export function getRecentTraces(limit: number = CAP): VerifyTrace[] {
  const take = Math.max(0, Math.min(limit, buffer.length));
  // Reverse without mutating the underlying buffer.
  const out: VerifyTrace[] = [];
  for (let i = buffer.length - 1; i >= buffer.length - take; i--) {
    const entry = buffer[i];
    if (entry !== undefined) out.push(entry);
  }
  return out;
}

/** Lookup a single trace by id. Returns undefined if it's been evicted. */
export function getTraceById(id: string): VerifyTrace | undefined {
  for (let i = buffer.length - 1; i >= 0; i--) {
    const entry = buffer[i];
    if (entry !== undefined && entry.id === id) return entry;
  }
  return undefined;
}

/** Test-only: clear the buffer. Not exported through the public barrel. */
export function __resetTraceBufferForTests(): void {
  buffer.length = 0;
}

/** The buffer capacity (exported for tests / docs). */
export const TRACE_BUFFER_CAP = CAP;
