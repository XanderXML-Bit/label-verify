// The app must say it is independent and that results are not
// compliance determinations, and must not label itself a government app.

import { readFileSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { INDEPENDENCE_LINE } from "@/lib/demo-copy";

const read = (p: string) => readFileSync(path.join(process.cwd(), p), "utf8");

describe("independence line", () => {
  it("states non-official status and that results are not determinations", () => {
    expect(INDEPENDENCE_LINE).toContain("Not an official U.S. government website.");
    expect(INDEPENDENCE_LINE).toContain("Independent projects do not imply federal endorsement.");
    expect(INDEPENDENCE_LINE).toContain("Results are not compliance determinations.");
  });

  it("is rendered in the footer and in the printed result", () => {
    expect(read("src/app/layout.tsx")).toMatch(/\{INDEPENDENCE_LINE\}/);
    const printed = read("src/app/components/SingleResult.tsx").match(/\{INDEPENDENCE_LINE\}/g) ?? [];
    expect(printed.length).toBeGreaterThanOrEqual(2);
  });

  it("appears in the README", () => {
    expect(read("README.md")).toContain(INDEPENDENCE_LINE);
  });

  it("the web manifest does not use the government category", () => {
    const manifest = JSON.parse(read("public/manifest.webmanifest")) as { categories: string[] };
    expect(manifest.categories).not.toContain("government");
  });
});
