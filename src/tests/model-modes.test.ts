import { describe, expect, it } from "vitest";
import { DEFAULT_MODE_ID, MODES, getMode } from "@/lib/model-modes";

// ─── model-modes ────────────────────────────────────────────────────────────
//
// The catalogue is the single source of truth for the verify orchestrator's
// mode lookup (the public UI no longer surfaces a mode picker). These tests
// pin the *contract* (stable IDs, exactly five modes, lookup helper, "local"
// is offline) — they do not pin cost/latency display strings, which drift.

describe("MODES catalogue", () => {
  it("contains the five expected modes by stable ID", () => {
    expect(MODES).toHaveLength(5);
    const ids = MODES.map((m) => m.id).sort();
    expect(ids).toEqual(["balanced", "default", "fast", "local", "smart"]);
  });

  it("every mode has non-empty label, description, and approx hints", () => {
    for (const m of MODES) {
      expect(m.label.length).toBeGreaterThan(0);
      expect(m.description.length).toBeGreaterThan(0);
      expect(m.approxCostPer1k.length).toBeGreaterThan(0);
      expect(m.approxLatency.length).toBeGreaterThan(0);
    }
  });

  it("only the 'local' mode is networkRequired: false", () => {
    const offline = MODES.filter((m) => !m.networkRequired);
    expect(offline.map((m) => m.id)).toEqual(["local"]);
  });

  it("DEFAULT_MODE_ID points to a real mode in MODES", () => {
    expect(getMode(DEFAULT_MODE_ID)).toBeDefined();
  });
});

describe("getMode", () => {
  it("returns the right mode for a known id", () => {
    const smart = getMode("smart");
    expect(smart).toBeDefined();
    expect(smart?.id).toBe("smart");
    expect(smart?.label.toLowerCase()).toContain("smart");
  });

  it("returns the local mode and confirms its offline flag", () => {
    const local = getMode("local");
    expect(local).toBeDefined();
    expect(local?.networkRequired).toBe(false);
  });

  it("returns undefined for an unknown id", () => {
    expect(getMode("nope")).toBeUndefined();
    expect(getMode("")).toBeUndefined();
  });

  it("does not invoke the extractor factory at lookup time", () => {
    // The factory is the heavy part (touches env / SDK clients). Just
    // looking a mode up must be free — calling getMode() should never
    // throw on a missing GOOGLE_API_KEY.
    const original = process.env.GOOGLE_API_KEY;
    delete process.env.GOOGLE_API_KEY;
    try {
      expect(() => {
        const m = getMode("default");
        // Property reads are fine; we just don't *call* the factory.
        expect(m).toBeDefined();
      }).not.toThrow();
    } finally {
      if (original !== undefined) process.env.GOOGLE_API_KEY = original;
    }
  });
});
