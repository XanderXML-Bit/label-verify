// In-memory token-bucket rate limiter for the public demo. Per-IP cap on
// the verify endpoint. Not multi-instance-aware — Vercel may run multiple
// warm containers and the buckets are not shared. For a prototype that is
// acceptable; abuse would simply burn one container at a time. A real
// deployment would back this with Upstash/Redis.

interface Bucket {
  /** Tokens available right now (fractional). */
  tokens: number;
  /** Wall-clock ms of last refill. */
  updatedAt: number;
}

const BUCKETS = new Map<string, Bucket>();
const SWEEP_AFTER_MS = 60 * 60 * 1000;

export interface RateLimitOptions {
  /** Number of requests allowed per minute per key. */
  perMinute: number;
  /** Burst capacity (defaults to perMinute). */
  burst?: number;
}

export interface RateLimitResult {
  allowed: boolean;
  remaining: number;
  resetSeconds: number;
}

/**
 * Hit the bucket for `key`. Returns whether the request is allowed and
 * how many tokens remain. Tokens refill linearly at `perMinute / 60`
 * per second.
 */
export function rateLimit(key: string, opts: RateLimitOptions): RateLimitResult {
  const now = Date.now();
  const refillPerMs = opts.perMinute / 60_000;
  const cap = opts.burst ?? opts.perMinute;

  let bucket = BUCKETS.get(key);
  if (!bucket) {
    bucket = { tokens: cap, updatedAt: now };
    BUCKETS.set(key, bucket);
  } else {
    const elapsed = now - bucket.updatedAt;
    bucket.tokens = Math.min(cap, bucket.tokens + elapsed * refillPerMs);
    bucket.updatedAt = now;
  }

  if (bucket.tokens >= 1) {
    bucket.tokens -= 1;
    sweepStale(now);
    return {
      allowed: true,
      remaining: Math.floor(bucket.tokens),
      resetSeconds: Math.ceil((1 - bucket.tokens) / refillPerMs / 1000),
    };
  }
  return {
    allowed: false,
    remaining: 0,
    resetSeconds: Math.ceil((1 - bucket.tokens) / refillPerMs / 1000),
  };
}

let lastSweep = 0;
function sweepStale(now: number): void {
  if (now - lastSweep < SWEEP_AFTER_MS) return;
  lastSweep = now;
  for (const [k, b] of BUCKETS.entries()) {
    if (now - b.updatedAt > SWEEP_AFTER_MS) BUCKETS.delete(k);
  }
}

/**
 * Best-effort caller identity from request headers. Vercel sets
 * `x-forwarded-for`; fall back to the remote-address header. Returns
 * `"anonymous"` if neither is present.
 */
export function callerKey(headers: Headers): string {
  const xff = headers.get("x-forwarded-for");
  if (xff) {
    const first = xff.split(",")[0]?.trim();
    if (first) return first;
  }
  const realIp = headers.get("x-real-ip");
  if (realIp) return realIp.trim();
  const remote = headers.get("x-vercel-forwarded-for");
  if (remote) {
    const first = remote.split(",")[0]?.trim();
    if (first) return first;
  }
  return "anonymous";
}
