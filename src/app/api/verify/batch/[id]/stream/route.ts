import { getBatch, setItemError, setItemResult } from "@/lib/batch-store";
import { verifyLabel } from "@/lib/verify";

export const runtime = "nodejs";
export const maxDuration = 300;

const CONCURRENCY = 8;

/**
 * GET /api/verify/batch/[id]/stream
 *
 * Opens a Server-Sent Events stream. Internally fires up to CONCURRENCY
 * verifyLabel calls in parallel (each is its own per-item function call's
 * worth of work), emitting one SSE event per completed item.
 *
 * Event types:
 *   - "start"   { count }
 *   - "item"    { index, status, result | error }
 *   - "done"    { passed, failed, review, errored }
 *
 * If the client disconnects, the work stops on the next item boundary.
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

      send("start", { count: job.items.length });

      let i = 0;
      const pump = async (_workerId: number): Promise<void> => {
        while (!cancelled) {
          const idx = i++;
          if (idx >= job.items.length) return;
          const item = job.items[idx]!;
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

      await Promise.all(
        Array.from({ length: CONCURRENCY }, (_, idx) => pump(idx)),
      );

      const passed = job.items.filter((x) => x.result?.verdict === "pass").length;
      const failed = job.items.filter((x) => x.result?.verdict === "fail").length;
      const review = job.items.filter((x) => x.result?.verdict === "review").length;
      const errored = job.items.filter((x) => x.status === "error").length;
      send("done", { passed, failed, review, errored });

      try {
        controller.close();
      } catch {
        // already closed
      }
    },
    cancel() {
      cancelled = true;
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
