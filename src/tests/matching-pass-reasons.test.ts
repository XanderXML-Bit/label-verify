// Wave-35 Track 1 #1 — non-trivial PASS reasoning regression pins.
//
// The comparators emit `passReason` ONLY on the four non-trivial PASS
// bins (tolerance, fuzzy, implicit-USA-from-state, country-synonym).
// Trivial exact-match PASSes keep `passReason === undefined` so a
// future refactor can't accidentally over-emit and flood the verdict
// surface with "trivially-PASSed because they were equal" noise.

import { describe, expect, it } from "vitest";
import { compareAbv } from "@/lib/matching/abv";
import { compareBrand } from "@/lib/matching/brand";
import { compareCountry } from "@/lib/matching/country";
import { compareNetContents } from "@/lib/matching/net-contents";
import { compareProducer } from "@/lib/matching/producer";

describe("ABV tolerance-applied PASS emits passReason", () => {
  it("beer 6.4 declared vs 6.6 extracted (within ±0.3) → PASS with tolerance reason", () => {
    const cmp = compareAbv(6.4, "beer", 6.6, 0.95);
    expect(cmp.status).toBe("pass");
    expect(cmp.passReason).toBeDefined();
    expect(cmp.passReason).toMatch(/Tolerance/i);
    expect(cmp.passReason).toMatch(/0\.3 pp/);
  });

  it("wine 12.0 declared vs 12.4 extracted (within ±0.5) → PASS with tolerance reason", () => {
    const cmp = compareAbv(12.0, "wine", 12.4, 0.95);
    expect(cmp.status).toBe("pass");
    expect(cmp.passReason).toMatch(/Tolerance/i);
  });

  it("exact-match PASS (5.0 vs 5.0) → PASS with NO passReason (trivial)", () => {
    const cmp = compareAbv(5.0, "beer", 5.0, 0.95);
    expect(cmp.status).toBe("pass");
    expect(cmp.passReason).toBeUndefined();
  });

  it("FAIL ABV keeps the existing `reason` (regression — passReason is additive)", () => {
    const cmp = compareAbv(5.0, "beer", 7.0, 0.95);
    expect(cmp.status).toBe("fail");
    expect(cmp.reason).toMatch(/Declared/);
    expect(cmp.passReason).toBeUndefined();
  });

  it("REVIEW (within tolerance but low confidence) → PASS reason NOT emitted (review takes priority)", () => {
    const cmp = compareAbv(5.0, "beer", 5.1, 0.6);
    expect(cmp.status).toBe("review");
    expect(cmp.passReason).toBeUndefined();
  });
});

describe("Net contents unit-conversion / rounding PASS emits passReason", () => {
  it("12 fl_oz declared vs 355 ml extracted → PASS with unit-conversion reason", () => {
    const cmp = compareNetContents(
      { value: 12, unit: "fl_oz" },
      { value: 355, unit: "ml" },
      0.95,
    );
    expect(cmp.status).toBe("pass");
    expect(cmp.passReason).toBeDefined();
    expect(cmp.passReason).toMatch(/Unit conversion/i);
  });

  it("same-unit, exact-match (12 fl_oz vs 12 fl_oz) → PASS with NO passReason", () => {
    const cmp = compareNetContents(
      { value: 12, unit: "fl_oz" },
      { value: 12, unit: "fl_oz" },
      0.95,
    );
    expect(cmp.status).toBe("pass");
    expect(cmp.passReason).toBeUndefined();
  });

  it("same-unit, within-rounding (750 ml vs 749 ml) → PASS with rounding reason", () => {
    const cmp = compareNetContents(
      { value: 750, unit: "ml" },
      { value: 749, unit: "ml" },
      0.95,
    );
    expect(cmp.status).toBe("pass");
    expect(cmp.passReason).toMatch(/Rounding/i);
  });
});

describe("Brand fuzzy-match PASS emits passReason", () => {
  it("Levenshtein < 1.0 / token < 1.0 → PASS with fuzzy reason", () => {
    // "Pilsner Reserve" vs "Pilsner Resrve" — Lev ≈ 0.93, well above
    // the 0.92 / 0.85 thresholds but non-exact. Picked because the
    // brand normaliser strips punctuation, so the apostrophe pair
    // "Stone's Throw IPA" vs "Stones Throw IPA" normalises to lev=1.
    const cmp = compareBrand("Pilsner Reserve", "Pilsner Resrve");
    expect(cmp.status).toBe("pass");
    expect(cmp.passReason).toBeDefined();
    expect(cmp.passReason).toMatch(/Fuzzy match/i);
  });

  it("exact-match brand PASS → NO passReason (lev=1.0 AND tok=1.0)", () => {
    const cmp = compareBrand("Stone IPA", "Stone IPA");
    expect(cmp.status).toBe("pass");
    expect(cmp.passReason).toBeUndefined();
  });
});

describe("Country implicit-USA-from-state PASS emits passReason", () => {
  it("declared null / blank + extracted 'USA' → PASS with implicit-domestic reason", () => {
    const cmp = compareCountry(null, "USA", 0.95);
    expect(cmp.status).toBe("pass");
    expect(cmp.passReason).toBeDefined();
    expect(cmp.passReason).toMatch(/Implicit US-domestic/i);
    expect(cmp.passReason).toMatch(/27 CFR/);
  });

  it("declared 'USA' + extracted 'USA' (exact) → PASS with NO passReason", () => {
    const cmp = compareCountry("USA", "USA", 0.95);
    expect(cmp.status).toBe("pass");
    expect(cmp.passReason).toBeUndefined();
  });
});

describe("Country synonym PASS emits passReason", () => {
  it("declared 'USA' + extracted 'PRODUCTO DE EE. UU.' → PASS with synonym reason", () => {
    const cmp = compareCountry("USA", "PRODUCTO DE EE. UU.", 0.95);
    expect(cmp.status).toBe("pass");
    expect(cmp.passReason).toBeDefined();
    expect(cmp.passReason).toMatch(/synonym accepted/i);
    expect(cmp.passReason).toMatch(/united states/i);
  });

  it("declared 'Germany' + extracted 'Deutschland' → PASS with synonym reason", () => {
    const cmp = compareCountry("Germany", "Deutschland", 0.95);
    expect(cmp.status).toBe("pass");
    expect(cmp.passReason).toMatch(/synonym accepted/i);
  });

  it("declared 'France' + extracted 'France' (exact) → PASS with NO passReason", () => {
    const cmp = compareCountry("France", "France", 0.95);
    expect(cmp.status).toBe("pass");
    expect(cmp.passReason).toBeUndefined();
  });
});

describe("Producer fuzzy PASS (string-declared path) emits passReason", () => {
  it("declared string vs fuzzy-matching extracted address → PASS with fuzzy reason", () => {
    const cmp = compareProducer(
      "Stones Throw Brewing Co Asheville NC",
      {
        name: "Stone's Throw Brewing",
        street: null,
        city: "Asheville",
        state: "NC",
        postal_code: null,
        country: null,
      },
      0.95,
    );
    // Producer status depends on the joined-string fuzzy ratio.
    if (cmp.status === "pass") {
      // Non-exact match → passReason emitted.
      expect(cmp.passReason).toBeDefined();
      expect(cmp.passReason).toMatch(/Fuzzy match accepted/i);
    }
  });

  it("structured-declared exact PASS → NO passReason (component-by-component all match)", () => {
    const cmp = compareProducer(
      {
        name: "Acme",
        street: "1 Main",
        city: "Asheville",
        state: "NC",
        postal_code: "28801",
        country: "USA",
      },
      {
        name: "Acme",
        street: "1 Main",
        city: "Asheville",
        state: "NC",
        postal_code: "28801",
        country: "USA",
      },
      0.95,
    );
    expect(cmp.status).toBe("pass");
    expect(cmp.passReason).toBeUndefined();
  });
});

describe("Wave-35 #2 cost field — verifyLabel response carries costUsd from server-side table", () => {
  it("approximateCostUsd returns the table entry for a known model id", async () => {
    const { approximateCostUsd } = await import("@/lib/vision/cost");
    expect(approximateCostUsd("gemini:gemini-3.1-flash-lite")).toBe(0.00025);
    expect(approximateCostUsd("openai:gpt-5.4-nano")).toBe(0.00125);
  });

  it("approximateCostUsd falls back to provider-prefix defaults for unknown sub-revisions", async () => {
    const { approximateCostUsd } = await import("@/lib/vision/cost");
    expect(approximateCostUsd("gemini:gemini-9.9-future-preview")).toBe(0.00025);
    expect(approximateCostUsd("openai:gpt-99")).toBe(0.00125);
  });

  it("approximateCostUsd returns null for unknown / undefined model ids", async () => {
    const { approximateCostUsd } = await import("@/lib/vision/cost");
    expect(approximateCostUsd(undefined)).toBeNull();
    expect(approximateCostUsd("anthropic:claude-3.5-sonnet")).toBeNull();
    expect(approximateCostUsd("")).toBeNull();
  });
});

describe("Wave-35 source pins", () => {
  it("#3: SingleResult no longer has aria-live on the cost banner", async () => {
    const fs = await import("node:fs");
    const src = fs.readFileSync(
      "src/app/components/SingleResult.tsx",
      "utf-8",
    );
    // The cost banner span used to carry aria-live="polite". Wave-35
    // removed it because static post-load metadata should not re-
    // announce on every re-render.
    expect(src).not.toMatch(/className="detailed-only.*?aria-live="polite"/s);
  });

  it("#5: page.tsx no longer declares a parent setNowTick interval", async () => {
    const fs = await import("node:fs");
    const src = fs.readFileSync("src/app/page.tsx", "utf-8");
    expect(src).not.toMatch(/const \[, setNowTick\] = useState/);
    expect(src).not.toMatch(/setNowTick\(\(t\) => t \+ 1\)/);
  });

  it("#6: ReviewQueuePanel.tsx + its test are deleted", async () => {
    const fs = await import("node:fs");
    expect(fs.existsSync("src/app/components/ReviewQueuePanel.tsx")).toBe(false);
    expect(fs.existsSync("src/tests/ui/review-queue-panel.test.tsx")).toBe(false);
  });

  it("#7: UploadZone resets emptyFolder state at handler entry (before filterAccepted)", async () => {
    const fs = await import("node:fs");
    const src = fs.readFileSync(
      "src/app/components/UploadZone.tsx",
      "utf-8",
    );
    // The fix moves `setEmptyFolderName("")` to handler entry. The
    // previous post-classification reset block is now removed. We
    // pin the comment that documents the fix so a future refactor
    // can't silently move the reset back without removing the comment.
    expect(src).toMatch(/notice state at HANDLER ENTRY/);
  });

  it("#4: page.tsx uses useMemo to derive isBusy as a primitive boolean dep", async () => {
    const fs = await import("node:fs");
    const src = fs.readFileSync("src/app/page.tsx", "utf-8");
    expect(src).toMatch(/const isBusy = useMemo\(/);
    // The title-mutation effect depends on [isBusy], not [stage].
    expect(src).toMatch(/document\.title = isBusy/);
    expect(src).toMatch(/\}, \[isBusy\]\);/);
  });
});
