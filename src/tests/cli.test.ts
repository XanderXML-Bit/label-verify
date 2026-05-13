import { describe, expect, it } from "vitest";
import { execFileSync } from "node:child_process";
import { resolve } from "node:path";

// Smoke tests for the labelverify CLI. We invoke it as a subprocess so
// the test exercises the exact same entrypoint operators / CI scripts
// use, and asserts on the actual stdout/exit code.
//
// Network-touching commands (verify / extract / batch / parse-app on
// an image-of-form) are NOT exercised here — they'd require a real
// GOOGLE_API_KEY and would add ~3 s per call. Those are integration-
// tested via the bench harness + the Playwright E2E suite.

const CLI = resolve("bin/labelverify.ts");

// On Windows, npx is a .cmd shim and execFileSync needs `shell: true`
// to run shell builtins. Cross-platform: invoke via shell with the
// command string. timeout caps each invocation at 30 s.
function runCli(args: string[], env?: Record<string, string>): {
  stdout: string;
  stderr: string;
  status: number;
} {
  const argString = args.map((a) => `"${a.replace(/"/g, '\\"')}"`).join(" ");
  try {
    const stdout = execFileSync(`npx tsx "${CLI}" ${argString}`, {
      encoding: "utf-8",
      stdio: ["ignore", "pipe", "pipe"],
      env: { ...process.env, ...env },
      timeout: 30_000,
      shell: true,
    });
    return { stdout, stderr: "", status: 0 };
  } catch (err) {
    const e = err as { stdout?: Buffer | string; stderr?: Buffer | string; status?: number };
    return {
      stdout: typeof e.stdout === "string" ? e.stdout : (e.stdout?.toString() ?? ""),
      stderr: typeof e.stderr === "string" ? e.stderr : (e.stderr?.toString() ?? ""),
      status: e.status ?? 1,
    };
  }
}

describe("labelverify CLI — argument parsing + help", () => {
  it("prints help when no args are given", () => {
    const r = runCli([]);
    expect(r.status).toBe(0);
    expect(r.stdout).toContain("LabelVerify CLI");
    expect(r.stdout).toContain("Commands:");
    expect(r.stdout).toContain("verify");
    expect(r.stdout).toContain("extract");
    expect(r.stdout).toContain("parse-app");
    expect(r.stdout).toContain("batch");
    expect(r.stdout).toContain("samples");
    expect(r.stdout).toContain("health");
  });

  it("prints help with --help", () => {
    const r = runCli(["--help"]);
    expect(r.status).toBe(0);
    expect(r.stdout).toContain("LabelVerify CLI");
  });

  it("prints help with -h", () => {
    const r = runCli(["-h"]);
    expect(r.status).toBe(0);
    expect(r.stdout).toContain("LabelVerify CLI");
  });

  it("rejects unknown commands with exit 2", () => {
    const r = runCli(["bogus-command"]);
    expect(r.status).toBe(2);
    expect(r.stderr).toContain("Unknown command");
  });
});

describe("labelverify CLI — health command", () => {
  it("emits JSON when --json is set and exits 0 if GOOGLE_API_KEY present", () => {
    // Skip if the real env doesn't have GOOGLE_API_KEY — the test
    // suite shouldn't depend on operator-specific config.
    if (!process.env.GOOGLE_API_KEY) {
      return;
    }
    const r = runCli(["health", "--json"]);
    expect(r.status).toBe(0);
    const parsed = JSON.parse(r.stdout) as {
      ready: boolean;
      providers: Record<string, boolean>;
    };
    expect(parsed.ready).toBe(true);
    expect(parsed.providers.GOOGLE_API_KEY).toBe(true);
  });

  it("emits JSON + exits 1 when GOOGLE_API_KEY is unset", () => {
    const r = runCli(["health", "--json"], {
      GOOGLE_API_KEY: "",
      // Also clear OPENAI_API_KEY etc. so the test is deterministic.
      OPENAI_API_KEY: "",
      ANTHROPIC_API_KEY: "",
      OPENROUTER_API_KEY: "",
    });
    expect(r.status).toBe(1);
    const parsed = JSON.parse(r.stdout) as {
      ready: boolean;
      providers: Record<string, boolean>;
    };
    expect(parsed.ready).toBe(false);
    expect(parsed.providers.GOOGLE_API_KEY).toBe(false);
  });

  it("emits human-readable output by default", () => {
    if (!process.env.GOOGLE_API_KEY) return;
    const r = runCli(["health"]);
    expect(r.status).toBe(0);
    expect(r.stdout).toContain("LabelVerify health:");
    expect(r.stdout).toContain("GOOGLE_API_KEY");
  });
});

describe("labelverify CLI — samples command", () => {
  it("lists the 3 bundled samples (pass / fail / review)", () => {
    const r = runCli(["samples", "--json"]);
    expect(r.status).toBe(0);
    const parsed = JSON.parse(r.stdout) as Array<{
      id: string;
      expectedVerdict: string;
    }>;
    const ids = parsed.map((s) => s.id);
    expect(ids).toContain("pass");
    expect(ids).toContain("fail");
    expect(ids).toContain("review");
    const verdicts = parsed.map((s) => s.expectedVerdict);
    expect(verdicts).toEqual(expect.arrayContaining(["pass", "fail", "review"]));
  });

  it("emits human-readable output by default", () => {
    const r = runCli(["samples"]);
    expect(r.status).toBe(0);
    expect(r.stdout).toContain("Bundled samples:");
    expect(r.stdout).toContain("expected=pass");
    expect(r.stdout).toContain("expected=fail");
    expect(r.stdout).toContain("expected=review");
  });
});
