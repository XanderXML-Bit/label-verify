import { readFileSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { OFFLINE_SAMPLE_FIELDS, type OfflineSampleImage } from "@/lib/vision/offline-sample";
import { SAMPLES } from "@/lib/samples";
import { compareProducer } from "@/lib/matching/producer";

// The offline demo shows a recorded extraction next to the real label
// photo. A careful reader compares the two, so every "Found" value must
// be what the photo prints. The source of truth is the repo's corrected
// public ground truth for each photo (test-data-combined/ground-truth),
// which was checked against the images by hand.
//
// Audit 2026-11-13 (P0-4): the FAIL photo prints "Produced by Mercers
// Reserve Beverage Co., Denver, CO" but the fixture said "Mercer's
// Reserve Distilling", and both fixtures claimed a printed "USA" that
// neither label shows.

interface GroundTruth {
  fields: {
    brand_name: string;
    class_type: string;
    abv_percent: number;
    net_contents: { value: number; unit: string };
    producer: string;
    country_of_origin: string | null;
  };
}

const IMAGE_GT: Record<OfflineSampleImage, string> = {
  pass: "ai-label-0001.json",
  fail: "ai-label-0010.json",
};

function groundTruth(image: OfflineSampleImage): GroundTruth {
  const file = path.join(process.cwd(), "test-data-combined", "ground-truth", IMAGE_GT[image]);
  return JSON.parse(readFileSync(file, "utf8")) as GroundTruth;
}

/** "Name, City, ST" → parts, as printed on both sample labels. */
function splitProducer(s: string): { name: string; city: string; state: string } {
  const parts = s.split(",").map((p) => p.trim());
  const state = parts.pop() ?? "";
  const city = parts.pop() ?? "";
  return { name: parts.join(", "), city, state };
}

describe("offline sample fixtures match their label photos", () => {
  for (const image of ["pass", "fail"] as const) {
    it(`${image}.jpg: every recorded Found value is printed on the label`, () => {
      const gt = groundTruth(image).fields;
      const f = OFFLINE_SAMPLE_FIELDS[image];
      expect(f.brand_name.value).toBe(gt.brand_name);
      expect(String(f.class_type.value).toLowerCase()).toBe(gt.class_type.toLowerCase());
      expect(f.abv_percent.value).toBe(gt.abv_percent);
      expect(f.net_contents.value).toEqual(gt.net_contents);
      const producer = f.producer.value as Record<string, unknown>;
      const printed = splitProducer(gt.producer);
      expect(producer.name).toBe(printed.name);
      expect(producer.city).toBe(printed.city);
      expect(producer.state).toBe(printed.state);
      expect(producer.street).toBeNull();
      expect(producer.postal_code).toBeNull();
      // Neither label prints a country.
      expect(gt.country_of_origin).toBeNull();
      expect(producer.country).toBeNull();
      expect(f.country_of_origin.value).toBeNull();
    });
  }

  it("each sample's declared producer matches what its label prints", () => {
    for (const sample of SAMPLES) {
      const image: OfflineSampleImage = sample.id === "fail" ? "fail" : "pass";
      const printed = splitProducer(groundTruth(image).fields.producer);
      const declared = sample.declared.producer as Record<string, unknown>;
      expect(declared.name).toBe(printed.name);
      const cmp = compareProducer(
        sample.declared.producer,
        OFFLINE_SAMPLE_FIELDS[image].producer.value as never,
        0.95,
      );
      expect(cmp.status).toBe("pass");
    }
  });
});
