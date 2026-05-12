import { randomUUID } from "node:crypto";
import type { DeclaredFields, VerifyResponse } from "./types";

const EMPTY_IMAGE_BYTES = Buffer.alloc(0);

// In-memory per-batch state. Persisted only within a single Node process
// (Vercel serverless functions share memory only within one warm instance).
// The brief explicitly says no persistent storage; the prototype does not
// need to survive process restart.
//
// Shape: a Map of batchId → { items, results-so-far, started, done }.

export type BatchItemStatus = "pending" | "running" | "done" | "error";

export interface BatchItem {
  index: number;
  filename: string;
  /** PNG/JPEG/WebP bytes, kept in memory only during the batch. */
  imageBytes: Buffer;
  /** Mime type as provided. */
  mime: string;
  declared: DeclaredFields;
  status: BatchItemStatus;
  result?: VerifyResponse;
  error?: string;
}

export interface BatchJob {
  id: string;
  createdAt: number;
  items: BatchItem[];
  /** True while one SSE stream owns processing for this batch. */
  processing: boolean;
  /** Cursor — lowest index not yet acknowledged by an SSE subscriber. */
  // We don't need this for v1, but it's the obvious extension if we
  // implement mid-batch reconnect-with-cursor (UI-SPEC §4).
  doneCount: number;
}

const STORE = new Map<string, BatchJob>();
const MAX_BATCHES = 32;
// Aggregate in-memory cap across all live batches. Each batch holds raw
// image bytes in memory until its SSE stream consumes them; without an
// aggregate cap a few concurrent large batches can OOM the function.
const MAX_AGGREGATE_BYTES = 2 * 1024 * 1024 * 1024; // 2 GB
// Time-to-live for a batch with no active stream. Streams pull items via
// `getBatch(id)` repeatedly so an actively-running batch refreshes its
// `createdAt` implicitly (lookup); once the stream closes, the batch sits
// in memory holding image bytes until the next eviction sweep. The TTL
// caps that window so an abandoned batch doesn't pin memory for hours.
const BATCH_TTL_MS = 30 * 60 * 1000; // 30 minutes

function aggregateBytes(): number {
  let total = 0;
  for (const job of STORE.values()) {
    for (const it of job.items) total += it.imageBytes.byteLength;
  }
  return total;
}

export class BatchStoreFullError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "BatchStoreFullError";
  }
}

export function createBatch(items: Omit<BatchItem, "status">[]): BatchJob {
  sweepExpired();
  evictOldest();
  const incoming = items.reduce(
    (s, it) => s + it.imageBytes.byteLength,
    0,
  );
  if (aggregateBytes() + incoming > MAX_AGGREGATE_BYTES) {
    throw new BatchStoreFullError(
      "Aggregate batch memory cap reached. Try again in a few minutes once running batches finish.",
    );
  }
  const job: BatchJob = {
    id: randomUUID(),
    createdAt: Date.now(),
    items: items.map((it) => ({ ...it, status: "pending" })),
    processing: false,
    doneCount: 0,
  };
  STORE.set(job.id, job);
  return job;
}

function sweepExpired(): void {
  const now = Date.now();
  for (const [id, job] of STORE.entries()) {
    if (now - job.createdAt > BATCH_TTL_MS) STORE.delete(id);
  }
}

export function getBatch(id: string): BatchJob | undefined {
  return STORE.get(id);
}

export function deleteBatch(id: string): void {
  STORE.delete(id);
}

export function claimBatchProcessing(job: BatchJob): boolean {
  if (job.processing) return false;
  job.processing = true;
  return true;
}

export function releaseBatchProcessing(job: BatchJob): void {
  job.processing = false;
}

export function setItemResult(
  job: BatchJob,
  index: number,
  result: VerifyResponse,
): void {
  const item = job.items[index];
  if (!item) return;
  item.status = "done";
  item.result = result;
  item.imageBytes = EMPTY_IMAGE_BYTES;
  job.doneCount += 1;
}

export function setItemError(
  job: BatchJob,
  index: number,
  error: string,
): void {
  const item = job.items[index];
  if (!item) return;
  item.status = "error";
  item.error = error;
  item.imageBytes = EMPTY_IMAGE_BYTES;
  job.doneCount += 1;
}

function evictOldest(): void {
  while (STORE.size >= MAX_BATCHES) {
    let oldestId: string | null = null;
    let oldestTs = Infinity;
    for (const [id, job] of STORE.entries()) {
      if (job.createdAt < oldestTs) {
        oldestTs = job.createdAt;
        oldestId = id;
      }
    }
    if (!oldestId) break;
    STORE.delete(oldestId);
  }
}
