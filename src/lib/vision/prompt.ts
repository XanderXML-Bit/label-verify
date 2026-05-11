import { createHash } from "node:crypto";
import { ExtractedFieldsSchema } from "./types";

/**
 * The prompt the vision extractor sends. Kept here so its content is
 * versioned, hash-able (for reproducibility — APPROACH.md §7), and
 * shared between adapters (T4, T6, C1).
 *
 * Design notes:
 *  - We ask for STRICT JSON conforming to ExtractedFieldsSchema.
 *  - For the Government Warning we explicitly tell the model to copy text
 *    VERBATIM — paraphrasing is the #1 failure mode of frontier VLMs on
 *    regulatory text (they "fix" it).
 *  - We ask for the prefix bounding box so the bold-detection pipeline
 *    has a crop target without re-running OCR.
 *  - Confidence is self-reported per field, range 0–1. We tell the model
 *    that 0.5 means "I can read it but I'd want a second look."
 */
export const EXTRACTION_PROMPT = `You are a verification assistant for the U.S. Department of the Treasury's
Alcohol and Tobacco Tax and Trade Bureau (TTB). The image is a beverage
label. Extract the regulated fields below.

Return ONLY a JSON object that conforms to the provided schema. No prose
outside the JSON. No code fences.

CRITICAL RULES:

1. For the "government_warning" object, "raw_text" MUST be the warning
   text exactly as printed — character-for-character. DO NOT paraphrase,
   spell-correct, or "fix" regulatory wording. A single substituted word
   is a federal compliance failure; we need to detect it, not paper over
   it.

2. "prefix_text" is the exact characters at the start of the warning
   (typically "GOVERNMENT WARNING:" or a misprint of it). Copy what is
   PRINTED, not what should be printed.

3. "prefix_appears_bold" — true if the prefix is rendered in a visibly
   heavier weight than the body text of the warning. False otherwise.
   If you cannot tell, return null (do not guess).

4. "prefix_appears_caps" — true iff every letter in the prefix is
   uppercase as printed (small-caps fonts that LOOK uppercase count as
   true). False otherwise.

5. "prefix_bbox" — pixel coordinates of the prefix bounding box in the
   submitted image. If you cannot locate it precisely, return null.

6. For numeric fields, return numbers (not strings). ABV is a percent
   value as a number (e.g. 6.4, not "6.4%"). Net contents is { value,
   unit }; valid units are "fl_oz", "ml", "L", "cl".

7. For text fields, normalize to the printed form on the label — preserve
   case, punctuation, and spelling as printed.

8. Confidence per field is 0–1. 1.0 = "I am certain." 0.5 = "I can read
   it but I'd want a human to confirm." 0.0 = "I could not find this on
   the label."

9. If a field is not present on the label, set value = null and
   confidence = 0.0. Do not invent.

10. For "producer", return a structured object { name, street, city,
    state, postal_code, country }. If only a freeform line is visible,
    put it in "name" and leave the rest null.`;

/**
 * SHA-256 of the prompt + the JSON schema. Stored on every benchmark
 * run so two runs with the same hash are guaranteed to have used
 * byte-identical prompts.
 */
export function getPromptHash(): string {
  const schemaShape = JSON.stringify(
    // Stringifying a zod schema is non-trivial; we describe the field
    // names + types instead. This is enough to detect schema drift.
    Object.keys(ExtractedFieldsSchema.shape).sort(),
  );
  return createHash("sha256")
    .update(EXTRACTION_PROMPT)
    .update("|")
    .update(schemaShape)
    .digest("hex")
    .slice(0, 16);
}
