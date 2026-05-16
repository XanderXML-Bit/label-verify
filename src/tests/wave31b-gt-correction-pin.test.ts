// Wave-32 audit pin (Sub-agent B G8 / Hermes-flagged):
//
// `ai-label-0031` and `ai-label-0050` have printed-text typos baked into
// the rendered Government Warning ("defetts" / "youf abilty tc" / etc).
// Per 27 CFR §16.21's strict literal-text requirement, the wave-31b
// ground-truth correction marked them `text_matches_regulation: false`.
//
// If a future model swap silently fixes those typos in transcription
// (or our validator's normaliser becomes too lenient), the system would
// flip these to `text=pass` and we would lose wave-31j's
// `comp.false-fail = 0` reading without realising. This test pins the
// GT file shape so the regression is caught at unit-level.

import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

const STEMS = ["ai-label-0031", "ai-label-0050"];
const ROOT = join(__dirname, "..", "..", "test-data-combined", "ground-truth");

describe("wave-31b GT correction is pinned on disk (regulator-critical)", () => {
  for (const stem of STEMS) {
    it(`${stem}: government_warning.text_matches_regulation must be false (printed typos render the warning non-compliant under 27 CFR §16.21)`, () => {
      const path = join(ROOT, `${stem}.json`);
      expect(existsSync(path), `${path} must exist`).toBe(true);
      const gt = JSON.parse(readFileSync(path, "utf8")) as {
        fields: { government_warning: { text_matches_regulation: boolean } };
        notes?: string;
      };
      expect(
        gt.fields.government_warning.text_matches_regulation,
        `${stem} must remain marked NON-compliant on text grounds. If a model fix legitimately reads the typos correctly, that DOES NOT make the printed label compliant — the regulator-strict rule is whether the printed glyphs match the canonical statement, not whether the transcriber recovered the intent.`,
      ).toBe(false);
      // Notes should explain why — defensive against an accidental
      // "fix" by a maintainer who didn't read WAVE-31b.
      expect(gt.notes ?? "").toMatch(/typos|WAVE-31b|literal-text/i);
    });
  }
});
