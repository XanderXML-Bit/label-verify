// URL-image fetching with SSRF safeguards.
//
// The /api/verify endpoint accepts a URL pointing to a label image. Because
// the server fetches that URL on behalf of the caller, we must defend
// against Server-Side Request Forgery — refuse to dial:
//   - non-http(s) schemes (file://, gopher://, ftp://, etc.)
//   - private / loopback / link-local IPs (RFC1918 etc.)
//   - hostnames that resolve to those IPs (the caller doesn't get to
//     point us at `127.0.0.1` via a custom hostname)
//
// Plus the usual hardening: bounded byte budget, hard timeout, MIME
// allow-list, redirect chain with re-validation at every hop.

import { lookup as dnsLookup } from "node:dns/promises";
import { Buffer } from "node:buffer";

export const URL_FETCH_TIMEOUT_MS = 10_000;
export const URL_FETCH_MAX_BYTES = 10 * 1024 * 1024; // 10MB, matches upload limit
export const URL_FETCH_MAX_REDIRECTS = 3;

const ALLOWED_MIME = new Set([
  "image/jpeg",
  "image/jpg",
  "image/png",
  "image/webp",
]);

export class UrlFetchError extends Error {
  readonly status: number;
  constructor(message: string, status = 400) {
    super(message);
    this.status = status;
  }
}

export interface FetchedUrlImage {
  buffer: Buffer;
  mime: string;
  finalUrl: string;
}

/**
 * Fetch a remote URL into memory, with SSRF defenses. Throws
 * UrlFetchError with an appropriate HTTP status on any failure.
 */
export async function fetchUrlImage(input: string): Promise<FetchedUrlImage> {
  let current = input.trim();
  if (!current) throw new UrlFetchError("URL is empty.", 400);

  for (let hop = 0; hop <= URL_FETCH_MAX_REDIRECTS; hop++) {
    let parsed: URL;
    try {
      parsed = new URL(current);
    } catch {
      throw new UrlFetchError(`Invalid URL: ${current}`, 400);
    }

    if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
      throw new UrlFetchError(
        `Unsupported URL scheme "${parsed.protocol}". Only http(s) is allowed.`,
        400,
      );
    }

    await assertHostnameIsPublic(parsed.hostname);

    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), URL_FETCH_TIMEOUT_MS);
    let resp: Response;
    try {
      resp = await fetch(parsed.toString(), {
        method: "GET",
        redirect: "manual", // we follow ourselves so each hop is re-validated
        signal: controller.signal,
        headers: {
          // Pretend to be a real browser so CDNs don't 403.
          "User-Agent":
            "LabelVerify/0.1 (+https://github.com/XanderXML-Bit/label-verify)",
          Accept: "image/*",
        },
      });
    } catch (err) {
      if ((err as Error).name === "AbortError") {
        throw new UrlFetchError(
          `URL fetch timed out after ${URL_FETCH_TIMEOUT_MS} ms.`,
          504,
        );
      }
      throw new UrlFetchError(
        `URL fetch failed: ${(err as Error).message}`,
        502,
      );
    } finally {
      clearTimeout(timer);
    }

    // Manual redirect handling so we re-run the SSRF check on each hop.
    if (resp.status >= 300 && resp.status < 400) {
      const location = resp.headers.get("location");
      if (!location) {
        throw new UrlFetchError(
          `Redirect ${resp.status} with no Location header.`,
          502,
        );
      }
      current = new URL(location, parsed).toString();
      continue;
    }

    if (!resp.ok) {
      throw new UrlFetchError(
        `Remote returned HTTP ${resp.status}.`,
        // map 4xx → 400-class, 5xx → 502 (gateway-ish)
        resp.status >= 500 ? 502 : 400,
      );
    }

    const mime = (resp.headers.get("content-type") ?? "").split(";")[0]!.trim().toLowerCase();
    if (!ALLOWED_MIME.has(mime)) {
      throw new UrlFetchError(
        `Unsupported MIME type "${mime || "(unknown)"}". Expected JPEG, PNG, or WebP.`,
        415,
      );
    }

    const reader = resp.body?.getReader();
    if (!reader) throw new UrlFetchError("Remote returned an empty body.", 502);

    const chunks: Uint8Array[] = [];
    let total = 0;
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      total += value.byteLength;
      if (total > URL_FETCH_MAX_BYTES) {
        try {
          await reader.cancel();
        } catch {
          // ignore
        }
        throw new UrlFetchError(
          `Remote image exceeds ${URL_FETCH_MAX_BYTES} bytes.`,
          413,
        );
      }
      chunks.push(value);
    }

    return {
      buffer: Buffer.concat(chunks),
      mime,
      finalUrl: parsed.toString(),
    };
  }

  throw new UrlFetchError(
    `Exceeded redirect limit (${URL_FETCH_MAX_REDIRECTS}).`,
    400,
  );
}

/**
 * Reject hostnames that resolve to private / loopback / link-local
 * addresses (the SSRF guard). Throws UrlFetchError on rejection.
 *
 * Note: We rely on the OS resolver. A subtly-resolving DNS server could
 * still surprise us between the lookup and the actual fetch (DNS rebinding),
 * but the cost of that attack here is "the prototype fetches a URL the
 * attacker controls" — there's no internal infrastructure to expose, since
 * this is a stateless public demo. We accept the residual risk for v1.
 */
async function assertHostnameIsPublic(hostname: string): Promise<void> {
  // URL parser keeps IPv6 literals bracketed (e.g. "[::1]"); strip for
  // checking.
  const cleaned = hostname.startsWith("[") && hostname.endsWith("]")
    ? hostname.slice(1, -1)
    : hostname;
  if (isIpLiteral(cleaned)) {
    if (isPrivateIp(cleaned)) {
      throw new UrlFetchError(
        `URL points at a private IP address (${cleaned}).`,
        400,
      );
    }
    return;
  }
  let resolved: { address: string; family: number }[];
  try {
    resolved = await dnsLookup(hostname, { all: true });
  } catch (err) {
    throw new UrlFetchError(
      `Could not resolve "${hostname}": ${(err as Error).message}`,
      400,
    );
  }
  for (const r of resolved) {
    if (isPrivateIp(r.address)) {
      throw new UrlFetchError(
        `Hostname "${hostname}" resolves to a private IP (${r.address}).`,
        400,
      );
    }
  }
}

function isIpLiteral(host: string): boolean {
  // IPv4 dotted-quad
  if (/^\d{1,3}\.\d{1,3}\.\d{1,3}\.\d{1,3}$/.test(host)) return true;
  // IPv6 — extremely loose check; the canonical fix would be ipaddr.js.
  if (host.includes(":") && /^[0-9a-fA-F:]+$/.test(host)) return true;
  return false;
}

function isPrivateIp(addr: string): boolean {
  // IPv4 private/loopback/link-local
  const v4 = addr.split(".").map((p) => Number.parseInt(p, 10));
  if (v4.length === 4 && v4.every((n) => Number.isFinite(n) && n >= 0 && n <= 255)) {
    const [a, b] = v4 as [number, number, number, number];
    if (a === 10) return true;
    if (a === 127) return true;
    if (a === 0) return true;
    if (a === 169 && b === 254) return true; // link-local
    if (a === 172 && b >= 16 && b <= 31) return true;
    if (a === 192 && b === 168) return true;
    if (a >= 224) return true; // multicast / reserved
    return false;
  }
  // IPv6 — loopback, unique-local fc00::/7, link-local fe80::/10
  const lower = addr.toLowerCase();
  if (lower === "::1" || lower === "::") return true;
  if (lower.startsWith("fc") || lower.startsWith("fd")) return true; // fc00::/7
  if (lower.startsWith("fe8") || lower.startsWith("fe9") || lower.startsWith("fea") || lower.startsWith("feb"))
    return true; // fe80::/10
  if (lower.startsWith("ff")) return true; // multicast
  return false;
}
