import { describe, expect, it } from "vitest";
import { SAMPLES, getSample } from "@/lib/samples";
import { DeclaredFieldsSchema } from "@/lib/types";

describe("samples", () => {
  describe("SAMPLES catalog", () => {
    it("exposes exactly three entries — pass / fail / review", () => {
      expect(SAMPLES).toHaveLength(3);
      const ids = SAMPLES.map((s) => s.id).sort();
      expect(ids).toEqual(["fail", "pass", "review"]);
    });

    it("every sample has a populated label, description, image URL and expected verdict", () => {
      for (const s of SAMPLES) {
        expect(s.label.trim().length).toBeGreaterThan(0);
        expect(s.shortDescription.trim().length).toBeGreaterThan(0);
        expect(s.imageUrl).toMatch(/^\/samples\//);
        expect(["pass", "fail", "review"]).toContain(s.expectedVerdict);
        expect(s.expectedNote.length).toBeGreaterThan(20);
      }
    });

    it("each sample's declared fields pass DeclaredFieldsSchema parsing", () => {
      for (const s of SAMPLES) {
        const parsed = DeclaredFieldsSchema.safeParse(s.declared);
        expect(parsed.success).toBe(true);
      }
    });
  });

  describe("getSample()", () => {
    it("returns the matching sample for each known id", () => {
      expect(getSample("pass").id).toBe("pass");
      expect(getSample("fail").id).toBe("fail");
      expect(getSample("review").id).toBe("review");
    });

    it("throws on an unknown id", () => {
      expect(() => getSample("nope" as never)).toThrow(/Unknown sample id/);
    });

    it("returned object is the same reference as the catalog entry", () => {
      const fromCatalog = SAMPLES.find((s) => s.id === "pass")!;
      expect(getSample("pass")).toBe(fromCatalog);
    });
  });
});
