import { describe, expect, it } from "vitest";
import {
  DEFAULT_GEMINI_RPM_LIMIT,
  DEFAULT_MAX_BATCH_ITEMS,
  computeBatchCapacity,
} from "@/lib/batch-capacity";

describe("batch capacity planning", () => {
  it("derives the default batch cap from Gemini RPM and Vercel stream duration", () => {
    expect(DEFAULT_GEMINI_RPM_LIMIT).toBe(30);
    expect(DEFAULT_MAX_BATCH_ITEMS).toBe(100);
  });

  it("keeps enough headroom under the provider and function limits", () => {
    expect(
      computeBatchCapacity({
        geminiRpm: 30,
        streamMaxDurationSec: 300,
        safetySeconds: 45,
        utilization: 0.8,
        maxHardCap: 1000,
      }),
    ).toBe(100);
  });

  it("scales upward only when a deployment provides a higher verified RPM", () => {
    expect(
      computeBatchCapacity({
        geminiRpm: 120,
        streamMaxDurationSec: 300,
        safetySeconds: 45,
        utilization: 0.8,
        maxHardCap: 1000,
      }),
    ).toBe(400);
  });
});
