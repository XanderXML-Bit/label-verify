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
 * Opens one processing stream for a batch. This is NOT Google's offline Batch
 * API; it is an interactive SSE worker in a single serverless invocation. We
 * therefore keep concurrency intentionally low and size accepted batches from
 * provider RPM + the 300s function window.
 */
export async function GET(
  _req: Request,
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
  let cancelled = false;

  const stream = new ReadableStream({
    async start(controller) {
      const send = (event: string, data: unknown) => {
        if (cancelled) return;
        try {
          controller.enqueue(
            encoder.encode(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`),
          );
        } catch {
          cancelled = true;
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
            if (item.status === "done" || item.status === "error") {
              continue;
            }
            item.status = "running";
            try {
              const result = await verifyLabel(item.imageBytes, item.declared);
              setItemResult(job, idx, result);
              send("item", {
                index: idx,
                filename: item.filename,
                status: "done",
                result,
              });
            } catch (err) {
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

        const passed = job.items.filter((x) => x.result?.verdict === "pass").length;
        const failed = job.items.filter((x) => x.result?.verdict === "fail").length;
        const review = job.items.filter((x) => x.result?.verdict === "review").length;
        const errored = job.items.filter((x) => x.status === "error").length;
        send("done", { passed, failed, review, errored });
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
      cancelled = true;
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
