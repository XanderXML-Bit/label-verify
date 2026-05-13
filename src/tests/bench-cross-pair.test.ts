// Unit + smoke tests for the cross-pair benchmark.
//
//   • perturb(): pure transform — verify determinism + that the
//     mutated record actually differs from the input on the five
//     targeted fields (catches "we forgot to mutate" regressions).
//   • bin/labelverify-bench.ts: help / arg parsing only — no real
//     verify calls (those require GOOGLE_API_KEY and ~5s per image).
//
// Same shell-quoting pattern as src/tests/cli.test.ts so the suite
// runs identically on Windows + POSIX.

import { describe, expect, it } from "vitest";
import { execFileSync } from "node:child_process";
import { resolve } from "node:path";
import { perturb } from "../../scripts/perturb-declared";

const BENCH = resolve("bin/labelverify-bench.ts");

function runCli(args: string[], env?: Record<string, string>): {
  stdout: string;
  stderr: string;
  status: number;
} {
  const argString = args.map((a) => `"${a.replace(/"/g, '\\"')}"`).join(" ");
  try {
    const stdout = execFileSync(`npx tsx "${BENCH}" ${argString}`, {
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

// A fixture matching the shape of a real GT JSON. Kept inline so the
// test is self-contained (and so a future schema change forces the
// caller to update the fixture intentionally, not silently).
const FIXTURE = {
  id: "syn-beer-test",
  source: "synthetic",
  image: "test-data-combined/labels/syn-beer-test.png",
  beverage_type: "beer",
  fields: {
    brand_name: "Bluerose",
    class_type: "Pale Ale",
    class_category: "beer",
    abv_percent: 6,
    net_contents: { value: 200, unit: "ml" },
    producer: {
      name: "Bluerose Beverage Co.",
      street: "802 Harbor Way",
      city: "Portland",
      state: "ME",
      postal_code: "04101",
      country: "USA",
    },
    country_of_origin: "USA",
    government_warning: {
      present: true,
      text_matches_regulation: true,
      prefix_all_caps: true,
      prefix_bold: true,
      meets_size_minimum: true,
    },
  },
  gov_warning_case: null,
};

describe("perturb-declared — mutation helper", () => {
  it("mutates brand_name, class_type, abv_percent, net_contents, country_of_origin", () => {
    const { perturbed, mutatedFields } = perturb(structuredClone(FIXTURE));
    expect(mutatedFields).toEqual(
      expect.arrayContaining([
        "brand_name",
        "class_type",
        "abv_percent",
        "net_contents",
        "country_of_origin",
      ]),
    );
    expect(perturbed.fields.brand_name).not.toBe(FIXTURE.fields.brand_name);
    expect(perturbed.fields.class_type).not.toBe(FIXTURE.fields.class_type);
    expect(perturbed.fields.abv_percent).toBe(FIXTURE.fields.abv_percent + 2);
    expect(perturbed.fields.net_contents.value).toBe(
      FIXTURE.fields.net_contents.value * 2,
    );
    expect(perturbed.fields.country_of_origin).not.toBe(
      FIXTURE.fields.country_of_origin,
    );
  });

  it("is deterministic — same input ⇒ byte-identical output", () => {
    const a = perturb(structuredClone(FIXTURE)).perturbed;
    const b = perturb(structuredClone(FIXTURE)).perturbed;
    expect(JSON.stringify(a)).toBe(JSON.stringify(b));
  });

  it("varies output across different GT ids (so two different labels don't get the same wrong brand)", () => {
    const a = perturb(structuredClone({ ...FIXTURE, id: "syn-beer-0001" })).perturbed;
    const b = perturb(structuredClone({ ...FIXTURE, id: "syn-spirits-0002" })).perturbed;
    // At least one of (brand, country) should differ across labels, otherwise
    // the perturb table is too small or the hash is collapsing.
    const same =
      a.fields.brand_name === b.fields.brand_name &&
      a.fields.country_of_origin === b.fields.country_of_origin;
    expect(same).toBe(false);
  });

  it("does not mutate the input object in place", () => {
    const original = structuredClone(FIXTURE);
    perturb(original);
    expect(original.fields.brand_name).toBe(FIXTURE.fields.brand_name);
    expect(original.fields.abv_percent).toBe(FIXTURE.fields.abv_percent);
  });

  it("handles null country_of_origin by setting a non-USA country", () => {
    const gt = structuredClone(FIXTURE);
    (gt.fields as { country_of_origin: string | null }).country_of_origin = null;
    const { perturbed, mutatedFields } = perturb(gt);
    expect(mutatedFields).toContain("country_of_origin");
    expect(perturbed.fields.country_of_origin).not.toBe("USA");
    expect(perturbed.fields.country_of_origin).not.toBeNull();
  });
});

describe("labelverify-bench CLI — argument parsing + help", () => {
  it("prints help when no args are given", () => {
    const r = runCli([]);
    expect(r.status).toBe(0);
    expect(r.stdout).toContain("cross-pair");
    expect(r.stdout).toContain("--corpus");
    expect(r.stdout).toContain("--limit");
  });

  it("prints help with --help", () => {
    const r = runCli(["--help"]);
    expect(r.status).toBe(0);
    expect(r.stdout).toContain("cross-pair");
  });

  it("rejects unknown commands with exit 2", () => {
    const r = runCli(["bogus-cmd"]);
    expect(r.status).toBe(2);
    expect(r.stderr).toContain("Unknown command");
  });

  it("fails fast when GOOGLE_API_KEY is missing", () => {
    const r = runCli(["cross-pair", "--limit", "1"], {
      GOOGLE_API_KEY: "",
      OPENAI_API_KEY: "",
      ANTHROPIC_API_KEY: "",
    });
    expect(r.status).toBe(1);
    expect(r.stderr).toContain("GOOGLE_API_KEY not set");
  });
});
