// Barrel export for the vision adapters. Re-exports the public surface
// so callers can `import { GeminiFlashExtractor } from "@/lib/vision"`
// without reaching into individual files.

export {
  GeminiFlashExtractor,
  GeminiFlashFullExtractor,
  GeminiProExtractor,
} from "./gemini";
export { GPT4oMiniExtractor, GPT4oFullExtractor } from "./openai";
export {
  ClaudeSonnetExtractor,
  ClaudeHaikuExtractor,
  ClaudeOpusExtractor,
} from "./anthropic";
export { OpenRouterExtractor } from "./openrouter";
export type {
  OpenRouterPricing,
  OpenRouterExtractorOptions,
} from "./openrouter";
export { TieredEscalationExtractor } from "./tiered";

export { EXTRACTION_PROMPT, getPromptHash } from "./prompt";

export {
  ExtractedFieldsSchema,
  ExtractedGovernmentWarningSchema,
  FieldWithConfidenceSchema,
  NetContentsSchema,
  ProducerAddressSchema,
} from "./types";
export type {
  ExtractedFields,
  ExtractedGovernmentWarning,
  Extractor,
  ExtractorContext,
  ExtractorCost,
  ExtractorResult,
  NetContents,
  OcrWord,
  ProducerAddress,
} from "./types";
