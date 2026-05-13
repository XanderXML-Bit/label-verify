import {
  claimBatchProcessing,
  deleteBatch,
  getBatch,
  releaseBatchProcessing,
  setItemError,
  setItemResult,
} from "@/lib/batch-store";
import { verifyLabel } from "@/lib/verify";

export const runtime = "nodejs";
export const maxDuration = 300;

const CONCURRENCY = 2;

/**
 * GET /api/verify/batch/[id]/stream
 *
 * Opens a Server-Sent Events stream. This is NOT Google's offline
 * Batch API — it is an interactive SSE worker in a single serverless
 * invocation. Internally fires up to CONCURRENCY verifyLabel calls in
 * parallel, emitting one SSE event per completed item.
 *
 * Event types:
 *   - "start"   { count }
 *   - "item"    { index, status, result | error }
 *   - "done"    { passed, failed, review, errored }
 *
 * If the client disconnects, the work stops on the next item boundary
 * AND any in-flight vision call is aborted via AbortController so we
 * don't keep billing the upstream model after the user has navigated
 * away. The request's own `signal` is also honored.
 *
 * Realistic batch ceiling: the POST route caps item count at
 * `MAX_BATCH_ITEMS` derived from `GEMINI_RPM_LIMIT` × the 300 s
 * stream window in `lib/batch-capacity.ts` (default ~100). On Hobby
 * plans the function's 60 s ceiling at CONCURRENCY=2 caps the
 * effective drain at ~40 items per stream-open (60 s / ~3 s per call
 * × 2 parallel). CONCURRENCY=2 is deliberately conservative: the
 * Gemini free-tier RPM is 15 and a single batch shares that quota
 * with any concurrent /api/verify calls. Reconnects currently
 * restart from item 0 (tracked in REMAINING-IMPROVEMENTS R6).
 */
export async function GET(
  req: Request,
  ctx: { params: Promise<{ id: string }> },
) {
  const { id } = await ctx.params;
  const job = getBatch(id);
  if (!job) {
    return new Response("Batch not found", { status: 404 });
  }
  if (!claimBatchProcessing(job)) {
    return new Response("Batch is already processing", { status: 409 });
  }

  const encoder = new TextEncoder();
  // Single controller wired through to every per-item verify. Aborted on
  // client disconnect, on request-side abort, or on stream cancel.
  const itemAbort = new AbortController();
  let cancelled = false;
  const cancel = () => {
    cancelled = true;
    try {
      itemAbort.abort();
    } catch {
      // already aborted
    }
  };
  // Propagate upstream abort signals (Next.js sets req.signal).
  if (req.signal) {
    if (req.signal.aborted) cancel();
    else req.signal.addEventListener("abort", cancel, { once: true });
  }

  const stream = new ReadableStream({
    async start(controller) {
      const send = (event: string, data: unknown) => {
        if (cancelled) return;
        try {
          controller.enqueue(
            encoder.encode(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`),
          );
        } catch {
          cancel();
        }
      };

      try {
        send("start", { count: job.items.length });

        let i = 0;
        const pump = async (): Promise<void> => {
          while (!cancelled) {
            const idx = i++;
            if (idx >= job.items.length) return;
            const item = job.items[idx]!;
            // Skip items already processed on a previous invocation
            // (the new claimBatchProcessing/releaseBatchProcessing
            // lifecycle prevents two streams from competing on the
            // same job, but a single reconnect after a soft cancel
            // can replay items 0..n−1; this short-circuit resumes
            // from where we left off).
            if (item.status === "done" || item.status === "error") {
              continue;
            }
            item.status = "running";
            try {
              // Thread the shared AbortController into the per-item
              // verify so a client disconnect propagates through to
              // the vision SDK and stops billing immediately (code-
              // review B3). Sharing one signal across CONCURRENCY=8
              // pumps is correct: every pump observes the same abort.
              const result = await verifyLabel(item.imageBytes, item.declared, {
                abortSignal: itemAbort.signal,
              });
              if (cancelled) return;
              setItemResult(job, idx, result);
              send("item", {
                index: idx,
                filename: item.filename,
                status: "done",
                result,
              });
            } catch (err) {
              if (cancelled) return;
              const msg = (err as Error).message;
              setItemError(job, idx, msg);
              send("item", {
                index: idx,
                filename: item.filename,
                status: "error",
                error: msg,
              });
            }
          }
        };

        await Promise.all(Array.from({ length: CONCURRENCY }, () => pump()));

        if (!cancelled) {
          const passed = job.items.filter((x) => x.result?.verdict === "pass").length;
          const failed = job.items.filter((x) => x.result?.verdict === "fail").length;
          const review = job.items.filter((x) => x.result?.verdict === "review").length;
          const errored = job.items.filter((x) => x.status === "error").length;
          send("done", { passed, failed, review, errored });
        }
      } finally {
        releaseBatchProcessing(job);
        if (!cancelled) deleteBatch(id);
        try {
          controller.close();
        } catch {
          // already closed
        }
      }
    },
    cancel() {
      // Two-phase: the `cancel()` helper aborts itemAbort (so any
      // in-flight vision call tears down its HTTP connection), then
      // we release the batch claim so a reconnect can pick up where
      // we left off.
      cancel();
      releaseBatchProcessing(job);
    },
  });

  return new Response(stream, {
    headers: {
      "Content-Type": "text/event-stream",
      "Cache-Control": "no-cache, no-transform",
      Connection: "keep-alive",
      "X-Accel-Buffering": "no",
    },
  });
}
