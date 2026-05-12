// ─── Review Queue ────────────────────────────────────────────────────────────
//
// Intelligence-first product priority: when verifyLabel can't be 100% certain
// a label is compliant, we DEFER to a human-review queue rather than rolling
// the dice on a PASS. This module is the in-memory FIFO that backs that queue.
//
// Design notes:
//   - In-memory only. The deployment target (Vercel) runs serverless functions
//     with no persistent shared state across instances. This is the prototype
//     queue; a production deployment would back it with Redis / Postgres.
//   - FIFO with a hard cap (200). When full, the oldest pending item is
//     dropped — older labels are less actionable. This is the same trade-off
//     `debug-trace`'s ring buffer makes.
//   - Resolution removes the item from the pending queue and records it in a
//     small rolling "resolved today" log for the stats endpoint.

import type { DeclaredFields, VerifyResponse } from "./types";

// ─── Public shape ───────────────────────────────────────────────────────────

export interface ReviewQueueItem {
  /** Stable id; URL-safe; sortable by creation. */
  id: string;
  /** Where this came from. Single-image verifier or batch run. */
  source: "single" | "batch";
  /** Optional filename if the caller has one — surfaced in the UI. */
  filename?: string;
  /** Epoch ms at enqueue time. */
  enqueuedAt: number;
  /** What the applicant declared on the COLA form. */
  declared: DeclaredFields;
  /** The verifier's full response, including per-field results. */
  verifyResponse: VerifyResponse;
  /** Human-readable reasons we routed this to review. */
  reasons: string[];
}

export interface ReviewResolution {
  resolvedBy: string;
  verdict: "pass" | "fail";
  notes?: string;
}

interface ResolvedRecord {
  id: string;
  resolvedAt: number;
  resolution: ReviewResolution;
  enqueuedAt: number;
}

// ─── Module state ───────────────────────────────────────────────────────────

/** Hard cap. When exceeded, the oldest item is evicted. */
export const MAX_QUEUE_SIZE = 200;

let pending: ReviewQueueItem[] = [];
let resolved: ResolvedRecord[] = [];

// ─── API ────────────────────────────────────────────────────────────────────

export function enqueueForReview(item: ReviewQueueItem): void {
  // De-dupe by id so a buggy caller can't insert the same trace twice.
  if (pending.some((p) => p.id === item.id)) return;
  pending.push(item);
  // FIFO cap: drop oldest first.
  while (pending.length > MAX_QUEUE_SIZE) {
    pending.shift();
  }
}

export function dequeueForReview(): ReviewQueueItem | undefined {
  return pending.shift();
}

export function peekQueue(limit?: number): ReviewQueueItem[] {
  const n = typeof limit === "number" && limit > 0 ? limit : pending.length;
  // Newest first — the UI wants "most recent items needing review."
  // FIFO order is preserved by `dequeueForReview`; this is a read-only peek.
  return [...pending].slice(-n).reverse();
}

export function markResolved(id: string, resolution: ReviewResolution): boolean {
  const idx = pending.findIndex((p) => p.id === id);
  if (idx === -1) return false;
  const [item] = pending.splice(idx, 1);
  if (!item) return false;
  resolved.push({
    id,
    enqueuedAt: item.enqueuedAt,
    resolvedAt: Date.now(),
    resolution,
  });
  pruneOldResolved();
  return true;
}

export function getStats(): {
  pending: number;
  resolvedToday: number;
  medianAgeMs: number;
} {
  const now = Date.now();
  pruneOldResolved(now);
  const since = startOfDay(now);
  const resolvedToday = resolved.filter((r) => r.resolvedAt >= since).length;
  const ages = pending.map((p) => now - p.enqueuedAt).sort((a, b) => a - b);
  const medianAgeMs =
    ages.length === 0
      ? 0
      : ages.length % 2 === 1
        ? ages[(ages.length - 1) >> 1]!
        : Math.round((ages[ages.length / 2 - 1]! + ages[ages.length / 2]!) / 2);
  return {
    pending: pending.length,
    resolvedToday,
    medianAgeMs,
  };
}

/** Test-only escape hatch. Not exported via index; tests import directly. */
export function _resetReviewQueueForTests(): void {
  pending = [];
  resolved = [];
}

// ─── Helpers ────────────────────────────────────────────────────────────────

function startOfDay(nowMs: number): number {
  const d = new Date(nowMs);
  d.setHours(0, 0, 0, 0);
  return d.getTime();
}

function pruneOldResolved(now: number = Date.now()): void {
  // Keep ~48h of resolution history so "resolvedToday" stays correct even
  // when the process has been up for more than a day. Anything older is
  // useless for the stats endpoint.
  const cutoff = now - 48 * 60 * 60 * 1000;
  resolved = resolved.filter((r) => r.resolvedAt >= cutoff);
}

/**
 * Generate a queue-item id. Same shape as VerifyTrace ids: short, URL-safe,
 * roughly sortable by creation. Not cryptographic — this is a routing key,
 * not a security boundary.
 */
export function makeReviewItemId(): string {
  const tail = Math.random().toString(36).slice(2, 8);
  return `rq-${Date.now().toString(36)}-${tail}`;
}
