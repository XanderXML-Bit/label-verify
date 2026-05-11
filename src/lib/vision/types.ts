import { z } from "zod";

export const NetContentsSchema = z.object({
  value: z.number().positive(),
  unit: z.enum(["fl_oz", "ml", "L", "cl"]),
});

export const ExtractedFieldsSchema = z.object({
  brand_name: z.string().nullable(),
  class_type: z.string().nullable(),
  abv_percent: z.number().nullable(),
  net_contents: NetContentsSchema.nullable(),
  government_warning_text: z.string().nullable(),
  government_warning_prefix_bold: z.boolean().nullable(),
  government_warning_prefix_caps: z.boolean().nullable(),
  producer_name_address: z.string().nullable(),
  country_of_origin: z.string().nullable(),
});
export type ExtractedFields = z.infer<typeof ExtractedFieldsSchema>;

export interface ExtractorContext {
  ocrText?: string;
}

export interface ExtractorResult {
  fields: ExtractedFields;
  rawOutput: unknown;
  latencyMs: number;
  modelId: string;
}

export interface Extractor {
  readonly id: string;
  readonly networkRequired: boolean;
  extract(image: Buffer, ctx?: ExtractorContext): Promise<ExtractorResult>;
}
