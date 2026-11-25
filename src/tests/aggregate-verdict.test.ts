// These cases pin the precedence of field statuses in the final verdict.

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
