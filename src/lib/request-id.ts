const SAFE_ID_RE = /^[A-Za-z0-9_-]{8,128}$/;

export function requestIdFor(headers: Headers): string {
  const inbound = headers.get("x-request-id");
  return inbound && SAFE_ID_RE.test(inbound) ? inbound : crypto.randomUUID();
}

/** Keep response IDs on upload routes that bypass middleware. */
export function withRequestId(
  handler: (req: Request, requestId: string) => Promise<Response>,
) {
  return async (req: Request): Promise<Response> => {
    const requestId = requestIdFor(req.headers);
    const response = await handler(req, requestId);
    response.headers.set("X-Request-Id", requestId);
    return response;
  };
}
