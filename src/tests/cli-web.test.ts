import { describe, expect, it } from "vitest";
import { execFileSync } from "node:child_process";
import { resolve } from "node:path";

// Smoke tests for the labelverify-web CLI (the HTTP driver). These
// exercise the CLI's argument parsing + help surface only — they do
// NOT hit a real HTTP endpoint, so they run fast and don't depend on
// network availability or the deployed app being up.
//
// The end-to-end "actually call the web app" verification lives in
// the production smoke workflow (.github/workflows/e2e-live.yml) and
// the Playwright E2E suite. We deliberately split it that way so the
// unit suite stays sub-second and offline-safe.

const CLI = resolve("bin/labelverify-web.ts");

function runCli(args: string[]): {
  stdout: string;
  stderr: string;
  status: number;
} {
  const argString = args.map((a) => `"${a.replace(/"/g, '\\"')}"`).join(" ");
  try {
    const stdout = execFileSync(`npx tsx "${CLI}" ${argString}`, {
      encoding: "utf-8",
      stdio: ["ignore", "pipe", "pipe"],
      env: { ...process.env },
      timeout: 30_000,
      shell: true,
    });
    return { stdout, stderr: "", status: 0 };
  } catch (err) {
    const e = err as {
      stdout?: Buffer | string;
      stderr?: Buffer | string;
      status?: number;
    };
    return {
      stdout:
        typeof e.stdout === "string" ? e.stdout : (e.stdout?.toString() ?? ""),
      stderr:
        typeof e.stderr === "string" ? e.stderr : (e.stderr?.toString() ?? ""),
      status: e.status ?? 1,
    };
  }
}

describe("labelverify-web CLI — argument parsing + help", () => {
  it("prints help when no args are given", () => {
    const r = runCli([]);
    expect(r.status).toBe(0);
    expect(r.stdout).toContain("LabelVerify web-driver CLI");
    expect(r.stdout).toContain("Commands:");
    expect(r.stdout).toContain("verify");
    expect(r.stdout).toContain("extract");
    expect(r.stdout).toContain("batch");
    expect(r.stdout).toContain("samples");
    expect(r.stdout).toContain("health");
    expect(r.stdout).toContain("--base-url");
    expect(r.stdout).toContain("--local");
  });

  it("prints help with --help", () => {
    const r = runCli(["--help"]);
    expect(r.status).toBe(0);
    expect(r.stdout).toContain("LabelVerify web-driver CLI");
  });

  it("prints help with -h", () => {
    const r = runCli(["-h"]);
    expect(r.status).toBe(0);
    expect(r.stdout).toContain("LabelVerify web-driver CLI");
  });

  it("rejects unknown commands with exit 2", () => {
    const r = runCli(["does-not-exist"]);
    expect(r.status).toBe(2);
    expect(r.stderr).toContain("Unknown command");
  });

  it("rejects --base-url without a value (exit 2)", () => {
    const r = runCli(["--base-url"]);
    expect(r.status).toBe(2);
  });

  it("rejects --timeout with a non-numeric value (exit 2)", () => {
    const r = runCli(["--timeout", "not-a-number", "health"]);
    expect(r.status).toBe(2);
  });
});

describe("labelverify-web CLI — response-shape regression guards", () => {
  // Caught post-merge of PR #21: the verify command's parseApplicationViaHttp
  // helper was looking for `body.declared` but /api/application/parse
  // returns `{fields, source, warnings, confidence}` (not `{declared}`).
  // This test keeps the shape contract explicit so a future refactor of
  // either side can't drift silently.
  it("CLI source declares the correct application/parse response shape", async () => {
    const { readFileSync } = await import("node:fs");
    const src = readFileSync(resolve("bin/labelverify-web.ts"), "utf8");
    // Must read `fields` from the parse response (not `declared` — the
    // /api/application/parse route never returns a `declared` field).
    expect(src).toMatch(/res\.body\.fields/);
    expect(src).not.toMatch(/res\.body\.declared/);
  });

  it("CLI source declares the correct verify response shape", async () => {
    const { readFileSync } = await import("node:fs");
    const src = readFileSync(resolve("bin/labelverify-web.ts"), "utf8");
    // /api/verify returns top-level `verdict` and `imageQuality` (not
    // nested under `result` or `body.result`). Lock the shape contract.
    expect(src).toMatch(/res\.body\.verdict/);
    expect(src).toMatch(/res\.body\.imageQuality/);
  });
});

describe("labelverify-web CLI — samples command", () => {
  // `samples` is the only command that doesn't actually hit the network
  // — it prints a hardcoded list that mirrors what the GUI offers — so
  // it's safe to exercise in the unit suite.

  it("lists the 3 bundled samples in JSON mode", () => {
    const r = runCli(["samples", "--json"]);
    expect(r.status).toBe(0);
    const parsed = JSON.parse(r.stdout) as Array<{
      id: string;
      expectedVerdict: string;
      path: string;
    }>;
    expect(parsed).toHaveLength(3);
    const ids = parsed.map((s) => s.id);
    expect(ids).toContain("pass");
    expect(ids).toContain("fail");
    expect(ids).toContain("review");
    for (const s of parsed) {
      expect(s.path).toMatch(/^\/samples\//);
    }
  });

  it("emits human-readable output by default", () => {
    const r = runCli(["samples"]);
    expect(r.status).toBe(0);
    expect(r.stdout).toContain("Bundled samples");
    expect(r.stdout).toContain("expected=pass");
    expect(r.stdout).toContain("expected=fail");
    expect(r.stdout).toContain("expected=review");
  });
});
