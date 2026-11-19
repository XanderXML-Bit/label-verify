import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

describe("Label Verify prototype identity", () => {
  it("keeps the retired title out of the header, metadata, and manifest", () => {
    for (const file of ["src/app/layout.tsx", "public/manifest.webmanifest"]) {
      expect(readFileSync(file, "utf8"), file).not.toMatch(/TTB\s+COLA\s+prototype/i);
    }
  });

  it("keeps the government category out of the web manifest", () => {
    const manifest = JSON.parse(readFileSync("public/manifest.webmanifest", "utf8")) as {
      categories: string[];
    };
    expect(manifest.categories.map((category) => category.toLowerCase())).not.toContain("government");
  });
});
