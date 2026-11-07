import { describe, expect, it } from "vitest";
import { resolveMetadataOrigin } from "../lib/site-metadata";

describe("static metadata origin", () => {
  it("defaults to the live app", () => {
    expect(resolveMetadataOrigin().href).toBe("https://label-verify-six.vercel.app/");
    expect(resolveMetadataOrigin(" ").href).toBe("https://label-verify-six.vercel.app/");
  });
  it("normalizes a configured origin", () => {
    expect(resolveMetadataOrigin(" https://preview.example.test/ ").origin).toBe("https://preview.example.test");
  });
  it.each([
    "not a URL", "ftp://example.test", "https://user:password@example.test",
    "https://example.test/path", "https://example.test/?query=1", "https://example.test/#fragment",
  ])("rejects non-origin input: %s", (input) => {
    expect(() => resolveMetadataOrigin(input)).toThrow();
  });
});
