/** Resolve the origin used only by static canonical and social metadata. */
export function resolveMetadataOrigin(value?: string): URL {
  const url = new URL(value?.trim() || "https://label-verify-six.vercel.app");
  if (
    !["https:", "http:"].includes(url.protocol) ||
    url.username || url.password || url.pathname !== "/" || url.search || url.hash
  ) {
    throw new Error("SITE_URL must be an HTTP(S) origin without credentials, a path, query, or fragment");
  }
  return url;
}
