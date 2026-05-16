import { GoogleGenerativeAI } from "@google/generative-ai";
import type { DeclaredFields } from "@/lib/types";
import { rowToDeclared } from "./row-to-declared";

// ─── Application-image vision extractor ────────────────────────────────────
//
// The reviewer hands us a PHOTO of a TTB application form (or some other
// document image where the seven declared fields are written out). We
// can't use the label extractor verbatim — that prompt looks for a
// beverage label, not a form. So we ship a small dedicated prompt that
// asks the model to find KV pairs by field name and emit a JSON object
// keyed exactly like the manifest rows. `rowToDeclared` then converts
// that into Partial<DeclaredFields> using the same alias plumbing as
// every other text-based path.
//
// Design notes:
//   - We deliberately pick Gemini Flash Lite for this even when the
//     bake-off settles on a different label-extractor primary. The
//     application-form path is text-heavy and field-named — the
//     accuracy ceiling is almost flat across frontier models, so we
//     pick the cheapest viable tier and let the reviewer correct in the
//     form. The MODEL_APPLICATION_VISION env var overrides if needed.
//   - We DON'T re-use the label vision adapter classes because they
//     parse into ExtractedFields (which includes government_warning,
//     prefix_bbox, etc. — irrelevant for a form). A direct call here
//     keeps the surface tiny.
//   - 30 s timeout — a form-image OCR pass is much faster than a label
//     compliance pass, and we're impatient. Beyond 30 s we surface
//     "vision unavailable" so the reviewer can fall back to manual entry.

const PROMPT = `You are reading a TTB Certificate of Label Approval (COLA)
application document image. Find the seven declared fields below and
return ONLY a JSON object with exactly those keys. Use the canonical
spelling. Set a value to null if the form does not clearly state it —
DO NOT guess.

Required JSON object (no prose, no code fences):

{
  "brand_name":         <string|null>,   // "Brand Name" field on the form
  "class_type":         <string|null>,   // "Class / Type" or "Class/Type"
  "class_category":     <"beer"|"wine"|"distilled_spirits"|"fortified_wine"|null>,
  "abv_percent":        <number|null>,   // e.g. 6.4 (without the % sign)
  "net_contents":       <string|null>,   // exactly as printed, e.g. "12 fl oz", "750 mL", "1.5 L"
  "producer":           <string|null>,   // applicant / producer name + address line
  "country_of_origin":  <string|null>    // ISO short name or 3-letter code
}

Examples of what to skip: serial numbers, OMB control numbers, signature
blocks, dates, plant ID, TTB use-only stamps. Stick to the seven keys.`;

const DEFAULT_MODEL = "gemini-3.1-flash-lite";
const DEFAULT_TIMEOUT_MS = 30_000;

export interface ApplicationImageOptions {
  apiKey: string;
  model?: string;
  timeoutMs?: number;
}

export async function parseApplicationImage(
  buffer: Buffer,
  mime: string,
  opts: ApplicationImageOptions,
): Promise<{
  fields: Partial<DeclaredFields>;
  warnings: string[];
  modelUsed: string;
}> {
  const warnings: string[] = [];
  const modelName = opts.model ?? process.env.MODEL_APPLICATION_VISION ?? DEFAULT_MODEL;
  const timeoutMs = opts.timeoutMs ?? DEFAULT_TIMEOUT_MS;

  const genai = new GoogleGenerativeAI(opts.apiKey);
  const model = genai.getGenerativeModel({
    model: modelName,
    generationConfig: { responseMimeType: "application/json", temperature: 0 },
  });

  // The @google/generative-ai SDK doesn't accept an AbortSignal directly,
  // so we race the call against a timeout-rejected promise. This is the
  // same pattern the other vision adapters (gemini.ts / openrouter.ts /
  // anthropic.ts) use. Without the race the 30 s budget claimed in the
  // header was fictional — the SDK ran to completion regardless.
  const timeoutPromise = new Promise<never>((_, reject) => {
    setTimeout(
      () => reject(new Error(`Application-image vision timed out after ${timeoutMs} ms.`)),
      timeoutMs,
    );
  });

  let text: string;
  try {
    const result = await Promise.race([
      model.generateContent({
        contents: [
          {
            role: "user",
            parts: [
              { text: PROMPT },
              {
                inlineData: {
                  mimeType: normaliseMime(mime),
                  data: buffer.toString("base64"),
                },
              },
            ],
          },
        ],
      }),
      timeoutPromise,
    ]);
    text = result.response.text();
  } catch (err) {
    throw new Error(
      `Application-image vision call failed: ${(err as Error).message}`,
    );
  }

  let json: unknown;
  try {
    json = JSON.parse(text);
  } catch (err) {
    throw new Error(
      `Application-image vision returned non-JSON: ${(err as Error).message}`,
    );
  }
  if (typeof json !== "object" || json === null) {
    throw new Error("Application-image vision returned non-object JSON.");
  }

  // Coerce model output into the row shape rowToDeclared expects, dropping
  // any null fields so the form's "untouched" state is preserved.
  const row: Record<string, string> = {};
  for (const [k, v] of Object.entries(json as Record<string, unknown>)) {
    if (v == null) continue;
    row[k] = typeof v === "string" ? v : String(v);
  }
  if (Object.keys(row).length === 0) {
    warnings.push(
      "Vision parsed no fields from the application image. Fill the form in manually.",
    );
  }
  return {
    fields: rowToDeclared(row),
    warnings,
    modelUsed: modelName,
  };
}

function normaliseMime(input: string): string {
  const lower = input.toLowerCase();
  // Gemini accepts image/jpeg, image/png, image/webp, image/heic, image/heif.
  if (lower === "image/jpg") return "image/jpeg";
  if (
    lower === "image/jpeg" ||
    lower === "image/png" ||
    lower === "image/webp" ||
    lower === "image/heic" ||
    lower === "image/heif"
  ) {
    return lower;
  }
  // Default — Gemini auto-sniffs reasonably well if given image/jpeg.
  return "image/jpeg";
}
