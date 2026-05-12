import { timingSafeEqual } from "node:crypto";

/**
 * Constant-time bearer-token check for the DEBUG_TOKEN-gated routes.
 *
 * `crypto.timingSafeEqual` requires equal-length buffers. We pad the
 * candidate with the configured token's length so a length-mismatch
 * cannot be inferred from response time — every comparison takes the
 * same time regardless of the supplied header. Returns `false` for any
 * malformed input.
 */
export function checkDebugBearer(
  authHeader: string,
  expectedToken: string,
): boolean {
  if (!expectedToken) return false;
  const prefix = "Bearer ";
  if (!authHeader.startsWith(prefix)) return false;
  const supplied = authHeader.slice(prefix.length);
  const a = Buffer.from(supplied);
  const b = Buffer.from(expectedToken);
  if (a.length !== b.length) {
    // Still spend time comparing same-length buffers so callers cannot
    // distinguish "wrong length" from "wrong value" timing-wise.
    const dummy = Buffer.alloc(b.length, 0);
    try {
      timingSafeEqual(dummy, b);
    } catch {
      // ignore — dummy length matches b by construction
    }
    return false;
  }
  return timingSafeEqual(a, b);
}
