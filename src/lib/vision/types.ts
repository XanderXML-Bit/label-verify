import { z } from "zod";
import type { OcrWord } from "../ocr";

export type { OcrWord };

// A single extracted field plus the model's self-reported confidence.
// Wrapping every field this way lets the matcher and the UI distinguish
// "the model is sure it is X" from "the model is guessing it is X."
// Tiered escalation (APPROACH.md §2.3 C5) keys off these confidences.
export const FieldWithConfidenceSchema = <T extends z.ZodTypeAny>(inner: T) =>
  z.object({
    value: inner.nullable(),
    confidence: z.number().min(0).max(1),
  });

export const NetContentsSchema = z.object({
  value: z.number().positive(),
  unit: z.enum(["fl_oz", "ml", "L", "cl"]),
});
export type NetContents = z.infer<typeof NetContentsSchema>;

// Producer / importer is a structured object, not a freeform string —
// supports per-component diff in the UI ("street matches, city doesn't")
// instead of collapsing the whole field to FAIL on one stray character.
export const ProducerAddressSchema = z.object({
  name: z.string().nullable(),
  street: z.string().nullable(),
  city: z.string().nullable(),
  state: z.string().nullable(),
  postal_code: z.string().nullable(),
  country: z.string().nullable(),
});
export type ProducerAddress = z.infer<typeof ProducerAddressSchema>;

// The Government Warning is special — see lib/validation/government-warning.ts
// for the strict checks. Here we capture what the extractor returns; the
// validator scores it.
export const ExtractedGovernmentWarningSchema = z.object({
  raw_text: z.string().nullable(),
  prefix_text: z.string().nullable(),
  prefix_bbox: z
    .object({
      x: z.number(),
      y: z.number(),
      width: z.number(),
      height: z.number(),
    })
    .nullable(),
  prefix_appears_bold: z.boolean().nullable(),
  prefix_appears_caps: z.boolean().nullable(),
});
export type ExtractedGovernmentWarning = z.infer<typeof ExtractedGovernmentWarningSchema>;

export const ExtractedFieldsSchema = z.object({
  brand_name: FieldWithConfidenceSchema(z.string()),
  class_type: FieldWithConfidenceSchema(z.string()),
  abv_percent: FieldWithConfidenceSchema(z.number()),
  net_contents: FieldWithConfidenceSchema(NetContentsSchema),
  government_warning: FieldWithConfidenceSchema(ExtractedGovernmentWarningSchema),
  producer: FieldWithConfidenceSchema(ProducerAddressSchema),
  country_of_origin: FieldWithConfidenceSchema(z.string()),
});
export type ExtractedFields = z.infer<typeof ExtractedFieldsSchema>;

// Anything an extractor wants to read besides the image. Today: OCR text
// (for the C1 OCR+vision combined path) and a hard timeout signal.
//
// Important semantic: OCR is *conditionally* off the critical path. The
// vision call does not wait for OCR — if OCR finishes first, its text is
// included in the prompt; if it doesn't, the vision call goes without and
// the C1 combined path degenerates to T4/T6. See ARCHITECTURE.md §4.3.
export interface ExtractorContext {
  ocrText?: string;
  ocrWords?: OcrWord[];
  signal?: AbortSignal;
}

// What the benchmark harness records. Cost, version, and prompt hash are
// not optional — without them APPROACH.md §7 "reproducibility" is a lie.
export interface ExtractorCost {
  inputTokens: number;
  outputTokens: number;
  costUsd: number;
}

export interface ExtractorResult {
  fields: ExtractedFields;
  rawOutput: unknown;
  latencyMs: number;
  modelId: string;
  modelVersion: string;
  promptHash: string;
  cost: ExtractorCost;
}

export interface Extractor {
  readonly id: string;
  readonly networkRequired: boolean;
  extract(image: Buffer, ctx?: ExtractorContext): Promise<ExtractorResult>;
}
