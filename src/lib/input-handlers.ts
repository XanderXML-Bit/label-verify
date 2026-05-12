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
  // IPv4 — dotted-quad, but ALSO non-canonical forms (decimal, hex,
  // octal, or shortened 3/2/1-component) that browsers and most clients
  // will resolve. URL parsers see `http://2130706433/` as 127.0.0.1; the
  // SSRF guard must too. See OWASP "URL parser inconsistencies."
  if (/^[0-9a-fA-FxX.]+$/.test(host)) {
    if (parseIpv4Loose(host) !== null) return true;
  }
  // IPv6 — extremely loose check; the canonical fix would be ipaddr.js.
  if (host.includes(":") && /^[0-9a-fA-F:]+$/.test(host)) return true;
  return false;
}

/**
 * Parse an IPv4 host into its canonical dotted-quad form, accepting:
 *   - 4 components (a.b.c.d)
 *   - 3 components (a.b.c — interprets c as a 16-bit word)
 *   - 2 components (a.b — interprets b as a 24-bit word)
 *   - 1 component (a — interprets a as a 32-bit integer)
 *   - Each component may be decimal, octal (leading 0), or hex (0x).
 *
 * Returns the canonical `a.b.c.d` string, or null if the input doesn't
 * parse as a valid IPv4 literal in any of these forms.
 */
function parseIpv4Loose(host: string): string | null {
  const parts = host.split(".");
  if (parts.length === 0 || parts.length > 4) return null;
  const nums = parts.map(parseNumberLoose);
  if (nums.some((n) => n === null)) return null;
  // Each leading part (all but the last) must fit in a byte.
  for (let i = 0; i < nums.length - 1; i++) {
    if ((nums[i] as number) < 0 || (nums[i] as number) > 0xff) return null;
  }
  const last = nums[nums.length - 1] as number;
  // The trailing part absorbs the remaining bits (32 / 24 / 16 / 8
  // depending on how many leading bytes there were).
  const maxLast =
    parts.length === 4
      ? 0xff
      : parts.length === 3
        ? 0xffff
        : parts.length === 2
          ? 0xffffff
          : 0xffffffff;
  if (last < 0 || last > maxLast) return null;
  // Compose the 32-bit address. Leading bytes occupy the high
  // positions; the trailing part absorbs the remaining (4 - leading)
  // bytes. Examples:
  //   "127.0.0.1"        → composed = (127<<24)|(0<<16)|(0<<8)|1     = 0x7F000001
  //   "127.1"            → leading=[127], trailing=1; composed = (127<<24)|1 = 0x7F000001
  //   "0x7f000001"       → leading=[], trailing=0x7f000001            = 0x7F000001
  //   "8.8.8.8"          → composed = (8<<24)|(8<<16)|(8<<8)|8        = 0x08080808
  // We use multiplication rather than `<<` because JS bitwise ops are
  // 32-bit signed; multiplying keeps the math in safe-integer space
  // before we narrow with masks.
  let composed = 0;
  for (let i = 0; i < nums.length - 1; i++) {
    composed = composed * 0x100 + (nums[i] as number);
  }
  // Make room for the trailing absorbed part (which can hold up to
  // (5 - nums.length) bytes), then add it.
  composed = composed * Math.pow(2, (5 - nums.length) * 8) + last;
  if (composed < 0 || composed > 0xffffffff) return null;
  const a = Math.floor(composed / 0x1000000) & 0xff;
  const b = Math.floor(composed / 0x10000) & 0xff;
  const c = Math.floor(composed / 0x100) & 0xff;
  const d = composed & 0xff;
  return `${a}.${b}.${c}.${d}`;
}

function parseNumberLoose(s: string): number | null {
  if (s === "") return null;
  // Hex.
  if (/^0[xX][0-9a-fA-F]+$/.test(s)) {
    const n = parseInt(s, 16);
    return Number.isFinite(n) ? n : null;
  }
  // Octal (leading 0 followed by octal digits).
  if (/^0[0-7]+$/.test(s)) {
    const n = parseInt(s, 8);
    return Number.isFinite(n) ? n : null;
  }
  // Decimal.
  if (/^\d+$/.test(s)) {
    const n = parseInt(s, 10);
    return Number.isFinite(n) ? n : null;
  }
  return null;
}

function isPrivateIp(addr: string): boolean {
  // IPv4 private/loopback/link-local. Normalise non-canonical forms
  // (decimal, hex, octal, 1/2/3-component) before checking — the
  // assertHostnameIsPublic caller passes the raw URL hostname, so a
  // URL like `http://017700000001/` reaches us as `017700000001`.
  const canonical = parseIpv4Loose(addr);
  if (canonical !== null) {
    const v4 = canonical.split(".").map((p) => Number.parseInt(p, 10));
    const [a, b] = v4 as [number, number, number, number];
    if (a === 10) return true;
    if (a === 127) return true;
    if (a === 0) return true;
    if (a === 169 && b === 254) return true; // link-local
    if (a === 172 && b >= 16 && b <= 31) return true;
    if (a === 192 && b === 168) return true;
    if (a === 100 && b >= 64 && b <= 127) return true; // CGNAT 100.64.0.0/10
    if (a === 255 && b === 255) return true; // 255.255.255.255 broadcast
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
