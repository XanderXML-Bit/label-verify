// Offline sample extractor for the keyless public demo.
//
// Stands in for the vision model when live model calls are disabled
// (see src/lib/demo-mode.ts). It never touches the network: it returns
// a recorded extraction for one of the bundled sample images. The field
// values come from the repo's own public ground truth for those images
// (test-data/ai-generated/ground-truth-v2/ai-label-0001.json and
// ai-label-0010.json), so the demo shows what the pipeline does with a
// correct read of each label. Everything downstream (field comparators,
// Government Warning validator with real OCR, verdict aggregation) runs
// for real on the server.

import { GOVERNMENT_WARNING_BODY, PREFIX_FULL } from "../validation/government-warning";
import type { Extractor, ExtractedFields, ExtractorContext, ExtractorResult } from "./types";

export const OFFLINE_SAMPLE_MODEL_ID = "offline-sample-fixture";

/** Which bundled image a sample uses. The REVIEW sample reuses pass.jpg. */
export type OfflineSampleImage = "pass" | "fail";

const CONF = 0.95;

const PASS_IMAGE_FIELDS: ExtractedFields = {
  brand_name: { value: "Mill Creek", confidence: CONF },
  class_type: { value: "Pilsner", confidence: CONF },
  abv_percent: { value: 5.2, confidence: CONF },
  net_contents: { value: { value: 12, unit: "fl_oz" }, confidence: CONF },
  government_warning: {
    value: {
      raw_text: `${PREFIX_FULL} ${GOVERNMENT_WARNING_BODY}`,
      prefix_text: PREFIX_FULL,
      prefix_bbox: null,
      prefix_appears_bold: true,
      prefix_appears_caps: true,
    },
    confidence: CONF,
  },
  producer: {
    value: {
      name: "Mill Creek Beverage Co.",
      street: null,
      city: "Asheville",
      state: "NC",
      postal_code: null,
      country: "USA",
    },
    confidence: CONF,
  },
  country_of_origin: { value: "USA", confidence: CONF },
};

const FAIL_IMAGE_FIELDS: ExtractedFields = {
  brand_name: { value: "Mercer's Reserve", confidence: CONF },
  class_type: { value: "Vodka", confidence: CONF },
  abv_percent: { value: 40, confidence: CONF },
  net_contents: { value: { value: 750, unit: "ml" }, confidence: CONF },
  government_warning: {
    value: {
      raw_text: `Government Warning: ${GOVERNMENT_WARNING_BODY}`,
      prefix_text: "Government Warning:",
      prefix_bbox: null,
      prefix_appears_bold: true,
      prefix_appears_caps: false,
    },
    confidence: CONF,
  },
  producer: {
    value: {
      name: "Mercer's Reserve Distilling",
      street: null,
      city: "Denver",
      state: "CO",
      postal_code: null,
      country: "USA",
    },
    confidence: CONF,
  },
  country_of_origin: { value: "USA", confidence: CONF },
};

export const OFFLINE_SAMPLE_FIELDS: Readonly<Record<OfflineSampleImage, ExtractedFields>> = {
  pass: PASS_IMAGE_FIELDS,
  fail: FAIL_IMAGE_FIELDS,
};

export class OfflineSampleExtractor implements Extractor {
  readonly id = OFFLINE_SAMPLE_MODEL_ID;
  readonly networkRequired = false;

  constructor(private readonly image: OfflineSampleImage) {}

  async extract(_image: Buffer, ctx?: ExtractorContext): Promise<ExtractorResult> {
    if (ctx?.signal?.aborted) {
      const err = new Error("aborted");
      err.name = "AbortError";
      throw err;
    }
    const fields = structuredClone(OFFLINE_SAMPLE_FIELDS[this.image]);
    return {
      fields,
      rawOutput: { offlineSample: this.image },
      latencyMs: 0,
      modelId: OFFLINE_SAMPLE_MODEL_ID,
      modelVersion: OFFLINE_SAMPLE_MODEL_ID,
      promptHash: "offline",
      cost: { inputTokens: 0, outputTokens: 0, costUsd: 0 },
    };
  }
}
