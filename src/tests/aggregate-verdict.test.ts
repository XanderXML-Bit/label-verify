// Wave-32 audit pin (Sub-agent B B5): aggregateVerdict is the single
// mutation point that promotes the worst per-field status into a final
// verdict. The whole-pipeline behaviour depends on this being correct;
// the 3-line implementation is trivial, but pinning the truth table
// is cheap insurance against a refactor flipping precedence.

import { describe, expect, it } from "vitest";
import { aggregateVerdict } from "@/lib/verify";

describe("aggregateVerdict — worst-status-wins precedence pin", () => {
  it("all pass → pass", () => {
    expect(aggregateVerdict(["pass", "pass", "pass"])).toBe("pass");
  });

  it("any review with no fail → review", () => {
    expect(aggregateVerdict(["pass", "pass", "review"])).toBe("review");
  });

  it("any fail wins over review and pass", () => {
    expect(aggregateVerdict(["pass", "review", "fail"])).toBe("fail");
    expect(aggregateVerdict(["fail", "pass", "pass"])).toBe("fail");
    expect(aggregateVerdict(["review", "review", "fail"])).toBe("fail");
  });

  it("single-element vectors collapse to their input", () => {
    expect(aggregateVerdict(["pass"])).toBe("pass");
    expect(aggregateVerdict(["review"])).toBe("review");
    expect(aggregateVerdict(["fail"])).toBe("fail");
  });

  it("empty input defaults to pass (vacuous truth — no failing field is no fail)", () => {
    expect(aggregateVerdict([])).toBe("pass");
  });

  it("precedence is strict: fail > review > pass — no ordering dependence", () => {
    // Order shouldn't matter: the function inspects the SET of statuses.
    expect(aggregateVerdict(["fail", "review"])).toBe("fail");
    expect(aggregateVerdict(["review", "fail"])).toBe("fail");
    expect(aggregateVerdict(["review", "pass"])).toBe("review");
    expect(aggregateVerdict(["pass", "review"])).toBe("review");
  });
});
