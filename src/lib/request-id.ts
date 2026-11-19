const SAFE_ID_RE = /^[A-Za-z0-9_-]{8,128}$/;

export function requestIdFor(headers: Headers): string {
  const inbound = headers.get("x-request-id");
  return inbound && SAFE_ID_RE.test(inbound) ? inbound : crypto.randomUUID();
}

/** Keep response IDs on upload routes that bypass middleware. */
export function withRequestId(
  handler: (req: Request, requestId: string) => Response | Promise<Response>,
) {
  return async (req: Request): Promise<Response> => {
    const requestId = requestIdFor(req.headers);
    try {
      const response = await handler(req, requestId);
      response.headers.set("X-Request-Id", requestId);
      return response;
    } catch (error) {
      console.error(`Upload route failed (request ID: ${requestId})`, error);
      return new Response(null, { status: 500, headers: { "X-Request-Id": requestId } });
    }
  };
}

// Next.js supplies these responses by default. Handle them here to attach
// the request ID without sending framed requests through middleware.
export const uploadMethodNotAllowed = withRequestId(() => new Response(null, { status: 405 }));
export const uploadOptions = withRequestId(() => new Response(null, {
  status: 204,
  headers: { Allow: "OPTIONS, POST" },
}));
