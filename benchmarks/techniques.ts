// Technique factories. Per APPROACH.md §2.1, scope is exactly four contenders:
//   T1 Tesseract OCR baseline (text-only — regex/heuristic field extraction)
//   T4 GPT-4o-mini Vision
//   T6 Gemini 2.0 Flash Vision
//   C1 OCR + Vision combined (T1 text fed into T6 via ExtractorContext.ocrText)
//
// Each factory is lazy so the runner can skip a technique when its prerequisite
// (API key, sibling extractor module) is missing — the rest of the run still
// proceeds, per the "graceful skip" requirement.

import type {
  ExtractedFields,
  Extractor,
  ExtractorContext,
  ExtractorCost,
} from "../src/lib/vision/types";
import { tesseractEngine } from "../src/lib/ocr/tesseract";
import { GeminiFlashExtractor } from "../src/lib/vision/gemini";

// ─── TechniqueRunner contract ───────────────────────────────────────────────

export interface TechniqueRunResult {
  fields: ExtractedFields;
  /**
   * Per-call cost accounting. T1 (Tesseract) returns undefined because
   * local OCR has no token cost. Vision-backed techniques propagate the
   * extractor's `ExtractorResult.cost` so the bench can aggregate
   * USD-per-1k-labels and accuracy-per-dollar on the Pareto frontier.
   */
  cost?: ExtractorCost;
}

export interface TechniqueRunner {
  /** Stable ID used in the results JSON. */
  readonly id: string;
  /**
   * Run the technique against one preprocessed image. Returns extracted
   * fields plus (when available) the per-call token + USD cost.
   */
  run(image: Buffer): Promise<TechniqueRunResult>;
}

export interface TechniqueFactory {
  readonly id: string;
  readonly networkRequired: boolean;
  build(): Promise<TechniqueRunner>;
}

// ─── Bake-off alias ─────────────────────────────────────────────────────────
//
// "bake-off" expands to T1 + T4 + T6 + C1 (core contenders) AND the
// extended candidates T4b + T5b + T6b + T6c so a single CLI flag runs the
// full Pareto-frontier comparison once all API keys are set. See
// `docs/MODEL-SELECTION.md` for what we're trying to learn from it.
export const BAKEOFF_TECHNIQUES: readonly string[] = [
  "T1",
  "T4",
  "T4b",
  "T5b",
  "T6",
  "T6b",
  "T6c",
  "T6d",
  "T6e",
  "T7",
  "T7b",
  "T8",
  "T9",
  "T10",
  "T11",
  "T12",
  "C1",
];

// ─── T1: Pure-OCR baseline ──────────────────────────────────────────────────
//
// The honest "could the simplest thing work?" baseline. Tesseract gives us raw
// text and word-level boxes; we use a few heuristics + regex to try to fill
// the structured fields. Confidence is fixed at 0.4 across the board — this
// is OCR-only, no semantic understanding. If a field cannot be inferred we
// leave it null (the scorer counts that as wrong) rather than guess.

const OCR_FIELD_CONFIDENCE = 0.4;

function emptyFields(): ExtractedFields {
  return {
    brand_name: { value: null, confidence: 0 },
    class_type: { value: null, confidence: 0 },
    abv_percent: { value: null, confidence: 0 },
    net_contents: { value: null, confidence: 0 },
    government_warning: {
      value: {
        raw_text: null,
        prefix_text: null,
        prefix_bbox: null,
        prefix_appears_bold: null,
        prefix_appears_caps: null,
      },
      confidence: 0,
    },
    producer: { value: null, confidence: 0 },
    country_of_origin: { value: null, confidence: 0 },
  };
}

const ABV_PATTERNS: RegExp[] = [
  // "6.4% ALC/VOL", "ALC 6.4% VOL", "ALC. BY VOL. 5.0%", "6,4% Vol"
  /(\d+(?:[.,]\d+)?)\s*%?\s*(?:alc(?:ohol)?\.?\s*\/?\s*vol|alc\.?\s*by\s*vol|abv|vol)/i,
  /(?:alc(?:ohol)?\.?\s*\/?\s*vol|alc\.?\s*by\s*vol|abv)\s*[:\s]*?(\d+(?:[.,]\d+)?)\s*%?/i,
  /(\d+(?:[.,]\d+)?)\s*%\s*alc/i,
];

const NET_PATTERNS: { re: RegExp; unit: "ml" | "fl_oz" | "L" | "cl" }[] = [
  { re: /(\d+(?:[.,]\d+)?)\s*ml\b/i, unit: "ml" },
  { re: /(\d+(?:[.,]\d+)?)\s*cl\b/i, unit: "cl" },
  { re: /(\d+(?:[.,]\d+)?)\s*l\b(?!\w)/i, unit: "L" },
  { re: /(\d+(?:[.,]\d+)?)\s*fl\.?\s*oz\b/i, unit: "fl_oz" },
];

const KNOWN_COUNTRIES: { token: string; canonical: string }[] = [
  { token: "USA", canonical: "USA" },
  { token: "U.S.A.", canonical: "USA" },
  { token: "UNITED STATES", canonical: "USA" },
  { token: "FRANCE", canonical: "France" },
  { token: "ITALY", canonical: "Italy" },
  { token: "SPAIN", canonical: "Spain" },
  { token: "GERMANY", canonical: "Germany" },
  { token: "IRELAND", canonical: "Ireland" },
  { token: "MEXICO", canonical: "Mexico" },
  { token: "CANADA", canonical: "Canada" },
  { token: "UNITED KINGDOM", canonical: "United Kingdom" },
];

const STYLE_TOKENS = [
  "IPA",
  "LAGER",
  "PILSNER",
  "PALE ALE",
  "WHEAT BEER",
  "STOUT",
  "PORTER",
  "SAISON",
  "DIPA",
  "AMBER ALE",
  "BROWN ALE",
  "BARLEYWINE",
  "CHARDONNAY",
  "MERLOT",
  "CABERNET SAUVIGNON",
  "PINOT NOIR",
  "PINOT GRIGIO",
  "SAUVIGNON BLANC",
  "RIESLING",
  "ZINFANDEL",
  "ROSE",
  "BOURBON",
  "WHISKEY",
  "WHISKY",
  "SCOTCH",
  "VODKA",
  "GIN",
  "RUM",
  "TEQUILA",
  "BRANDY",
  "COGNAC",
  "PORT",
  "SHERRY",
  "VERMOUTH",
  "MARSALA",
  "MADEIRA",
];

function parseNumberLoose(s: string): number | null {
  const n = Number(s.replace(",", "."));
  return Number.isFinite(n) ? n : null;
}

function extractAbv(text: string): number | null {
  for (const re of ABV_PATTERNS) {
    const m = text.match(re);
    if (m && m[1]) {
      const n = parseNumberLoose(m[1]);
      if (n !== null && n > 0 && n < 100) return n;
    }
  }
  return null;
}

function extractNetContents(
  text: string,
): { value: number; unit: "ml" | "fl_oz" | "L" | "cl" } | null {
  for (const { re, unit } of NET_PATTERNS) {
    const m = text.match(re);
    if (m && m[1]) {
      const n = parseNumberLoose(m[1]);
      if (n !== null && n > 0) return { value: n, unit };
    }
  }
  return null;
}

function extractCountry(text: string): string | null {
  const upper = text.toUpperCase();
  // Prefer "PRODUCT OF X" / "PRODUCED IN X" forms.
  const productOf = upper.match(
    /(?:PRODUCT\s+OF|PRODUCED\s+IN|BOTTLED\s+IN|MADE\s+IN)\s+([A-Z][A-Z .'-]{2,30})/,
  );
  if (productOf && productOf[1]) {
    const tail = productOf[1].trim().replace(/[.,].*$/, "").trim();
    for (const { token, canonical } of KNOWN_COUNTRIES) {
      if (tail.includes(token)) return canonical;
    }
  }
  for (const { token, canonical } of KNOWN_COUNTRIES) {
    if (upper.includes(token)) return canonical;
  }
  return null;
}

function extractClassType(text: string): string | null {
  const upper = text.toUpperCase();
  // Longest match wins so "PALE ALE" beats "ALE", "CABERNET SAUVIGNON" beats
  // "CABERNET", etc.
  const matches = STYLE_TOKENS.filter((t) => upper.includes(t)).sort(
    (a, b) => b.length - a.length,
  );
  return matches[0] ?? null;
}

function extractBrand(text: string): string | null {
  // Heuristic: brand is often the largest / first all-caps line near the top
  // of the label that is not the warning, not the class style, not a volume.
  const lines = text
    .split(/\r?\n/)
    .map((l) => l.trim())
    .filter(Boolean);
  for (const line of lines.slice(0, 8)) {
    const upper = line.toUpperCase();
    if (upper.startsWith("GOVERNMENT WARNING")) continue;
    if (NET_PATTERNS.some((p) => p.re.test(line))) continue;
    if (ABV_PATTERNS.some((p) => p.test(line))) continue;
    // A brand candidate should be mostly letters and have at least one
    // capital cluster of length >= 3.
    const letters = line.replace(/[^A-Za-z]/g, "");
    if (letters.length < 3) continue;
    if (!/[A-Z]{3,}/.test(line)) {
      // accept Title Case lines too if no all-caps candidate later
      if (!/^[A-Z][a-z]+(?:\s+[A-Z][a-z]+)*$/.test(line)) continue;
    }
    return line.replace(/[^\p{L}\p{N}'.\s&-]/gu, "").trim() || null;
  }
  return null;
}

function extractGovernmentWarning(text: string): {
  raw_text: string | null;
  prefix_text: string | null;
} {
  const idx = text.search(/GOVERNMENT\s+WARNING/i);
  if (idx < 0) return { raw_text: null, prefix_text: null };
  // Take from the prefix onwards until two consecutive newlines or end-of-text.
  const tail = text.slice(idx);
  const end = tail.search(/\n\s*\n/);
  const raw = (end >= 0 ? tail.slice(0, end) : tail).trim();
  // Prefix is everything before the first colon (if present), else first two
  // words.
  const colon = raw.indexOf(":");
  const prefix =
    colon > 0
      ? raw.slice(0, colon + 1).trim()
      : raw.split(/\s+/).slice(0, 2).join(" ");
  return { raw_text: raw, prefix_text: prefix };
}

class TesseractOnlyRunner implements TechniqueRunner {
  readonly id = "T1";

  async run(image: Buffer): Promise<TechniqueRunResult> {
    const ocr = await tesseractEngine.run(image);
    const text = ocr.text;

    const fields = emptyFields();

    const brand = extractBrand(text);
    if (brand) {
      fields.brand_name = { value: brand, confidence: OCR_FIELD_CONFIDENCE };
    }

    const cls = extractClassType(text);
    if (cls) {
      fields.class_type = { value: cls, confidence: OCR_FIELD_CONFIDENCE };
    }

    const abv = extractAbv(text);
    if (abv !== null) {
      fields.abv_percent = { value: abv, confidence: OCR_FIELD_CONFIDENCE };
    }

    const nc = extractNetContents(text);
    if (nc) {
      fields.net_contents = { value: nc, confidence: OCR_FIELD_CONFIDENCE };
    }

    const country = extractCountry(text);
    if (country) {
      fields.country_of_origin = {
        value: country,
        confidence: OCR_FIELD_CONFIDENCE,
      };
    }

    const gw = extractGovernmentWarning(text);
    fields.government_warning = {
      value: {
        raw_text: gw.raw_text,
        prefix_text: gw.prefix_text,
        prefix_bbox: null, // OCR-only baseline: no bbox attribution attempted
        prefix_appears_bold: null,
        prefix_appears_caps:
          gw.prefix_text === null ? null : gw.prefix_text === gw.prefix_text.toUpperCase(),
      },
      confidence: gw.raw_text ? OCR_FIELD_CONFIDENCE : 0,
    };

    // T1 is local OCR only — no token cost.
    return { fields };
  }
}

// ─── Vision-extractor adapter ───────────────────────────────────────────────

class VisionExtractorRunner implements TechniqueRunner {
  constructor(
    readonly id: string,
    private readonly extractor: Extractor,
    private readonly withOcr: boolean,
  ) {}

  async run(image: Buffer): Promise<TechniqueRunResult> {
    let ctx: ExtractorContext | undefined;
    if (this.withOcr) {
      // C1: run OCR first, hand its text to the vision call as a hint.
      try {
        const ocr = await tesseractEngine.run(image);
        ctx = { ocrText: ocr.text, ocrWords: ocr.words };
      } catch {
        // OCR failure → C1 degenerates to plain vision call. Per ARCHITECTURE.
        ctx = undefined;
      }
    }
    const result = await this.extractor.extract(image, ctx);
    return { fields: result.fields, cost: result.cost };
  }
}

// ─── Factories ──────────────────────────────────────────────────────────────

export const BUILTIN_TECHNIQUES: readonly TechniqueFactory[] = [
  {
    id: "T1",
    networkRequired: false,
    build: async () => new TesseractOnlyRunner(),
  },
  {
    id: "T4",
    networkRequired: true,
    build: async () => {
      const apiKey = process.env.OPENAI_API_KEY;
      if (!apiKey) {
        throw new Error(
          "T4 requires OPENAI_API_KEY (GPT-4o-mini Vision). Set it in .env.local.",
        );
      }
      // Dynamic import: the sibling extractor module may not exist yet.
      let mod: { GPT4oMiniExtractor: new (opts: { apiKey: string }) => Extractor };
      try {
        mod = (await import("../src/lib/vision/openai")) as typeof mod;
      } catch (err) {
        throw new Error(
          `T4 extractor module not available: ${(err as Error).message}. ` +
            `Expected src/lib/vision/openai.ts to export GPT4oMiniExtractor.`,
        );
      }
      const extractor = new mod.GPT4oMiniExtractor({ apiKey });
      return new VisionExtractorRunner("T4", extractor, false);
    },
  },
  {
    id: "T6",
    networkRequired: true,
    build: async () => {
      const apiKey = process.env.GOOGLE_API_KEY;
      if (!apiKey) {
        throw new Error(
          "T6 requires GOOGLE_API_KEY (Gemini 2.0 Flash Vision). Set it in .env.local.",
        );
      }
      const extractor = new GeminiFlashExtractor({
        apiKey,
        modelVersion: process.env.MODEL_PRIMARY ?? undefined,
      });
      return new VisionExtractorRunner("T6", extractor, false);
    },
  },
  {
    id: "C1",
    networkRequired: true,
    build: async () => {
      const apiKey = process.env.GOOGLE_API_KEY;
      if (!apiKey) {
        throw new Error(
          "C1 requires GOOGLE_API_KEY (combines Tesseract + Gemini Flash). Set it in .env.local.",
        );
      }
      const extractor = new GeminiFlashExtractor({
        apiKey,
        modelVersion: process.env.MODEL_PRIMARY ?? undefined,
      });
      return new VisionExtractorRunner("C1", extractor, true);
    },
  },
  // ─── Bake-off extended candidates (T4b / T5b / T6b / T6c) ────────────────
  //
  // Per APPROACH.md §2.1, the four core contenders (T1, T4, T6, C1) settle
  // the initial Pareto question. The candidates below feed the *bake-off
  // run* (full-corpus comparison once the final corpus lands) and let us
  // tell "fastest / cheapest / smartest" apart across providers. Each
  // factory mirrors the T4/T6 dynamic-import pattern so a missing API key
  // or missing sibling extractor module fails *gracefully at build time*,
  // not at module-load.
  {
    id: "T4b",
    networkRequired: true,
    build: async () => {
      const apiKey = process.env.OPENAI_API_KEY;
      if (!apiKey) {
        throw new Error(
          "T4b requires OPENAI_API_KEY (GPT-4o full Vision). Set it in .env.local.",
        );
      }
      let mod: { GPT4oFullExtractor: new (opts: { apiKey: string }) => Extractor };
      try {
        mod = (await import("../src/lib/vision/openai")) as typeof mod;
      } catch (err) {
        throw new Error(
          `T4b extractor module not available: ${(err as Error).message}. ` +
            `Expected src/lib/vision/openai.ts to export GPT4oFullExtractor.`,
        );
      }
      const extractor = new mod.GPT4oFullExtractor({ apiKey });
      return new VisionExtractorRunner("T4b", extractor, false);
    },
  },
  {
    id: "T5b",
    networkRequired: true,
    build: async () => {
      // Prefer OpenRouter when its key is set — same model, no
      // dependency on the Anthropic direct-SDK key being valid (the
      // current Zendren-shared key returns 401 invalid). Direct path
      // stays available for environments that have a live Anthropic key
      // and want to consolidate billing there.
      const routerKey = process.env.OPENROUTER_API_KEY;
      const directKey = process.env.ANTHROPIC_API_KEY;
      const preferRouter =
        process.env.ANTHROPIC_USE_OPENROUTER === "1" ||
        (routerKey && !directKey);
      if (routerKey && preferRouter) {
        let mod: {
          OpenRouterExtractor: new (opts: {
            apiKey: string;
            modelSlug: string;
            pricing: { inputPer1M: number; outputPer1M: number };
            structuredOutput?: boolean;
          }) => Extractor;
        };
        try {
          mod = (await import("../src/lib/vision/openrouter")) as typeof mod;
        } catch (err) {
          throw new Error(
            `T5b extractor module not available: ${(err as Error).message}. ` +
              `Expected src/lib/vision/openrouter.ts to export OpenRouterExtractor.`,
          );
        }
        const extractor = new mod.OpenRouterExtractor({
          apiKey: routerKey,
          modelSlug: "anthropic/claude-haiku-4.5",
          pricing: { inputPer1M: 1, outputPer1M: 5 },
          structuredOutput: false,
        });
        return new VisionExtractorRunner("T5b", extractor, false);
      }
      if (!directKey) {
        throw new Error(
          "T5b requires ANTHROPIC_API_KEY (direct, preferred) or " +
            "OPENROUTER_API_KEY (proxied via OpenRouter). Set one in .env.local.",
        );
      }
      let mod: { ClaudeHaikuExtractor: new (opts: { apiKey: string }) => Extractor };
      try {
        mod = (await import("../src/lib/vision/anthropic")) as typeof mod;
      } catch (err) {
        throw new Error(
          `T5b extractor module not available: ${(err as Error).message}. ` +
            `Expected src/lib/vision/anthropic.ts to export ClaudeHaikuExtractor.`,
        );
      }
      const extractor = new mod.ClaudeHaikuExtractor({ apiKey: directKey });
      return new VisionExtractorRunner("T5b", extractor, false);
    },
  },
  {
    id: "T6b",
    networkRequired: true,
    build: async () => {
      const apiKey = process.env.GOOGLE_API_KEY;
      if (!apiKey) {
        throw new Error(
          "T6b requires GOOGLE_API_KEY (Gemini 2.5 Flash full Vision). Set it in .env.local.",
        );
      }
      let mod: {
        GeminiFlashFullExtractor: new (opts: { apiKey: string }) => Extractor;
      };
      try {
        mod = (await import("../src/lib/vision/gemini")) as typeof mod;
      } catch (err) {
        throw new Error(
          `T6b extractor module not available: ${(err as Error).message}. ` +
            `Expected src/lib/vision/gemini.ts to export GeminiFlashFullExtractor.`,
        );
      }
      const extractor = new mod.GeminiFlashFullExtractor({ apiKey });
      return new VisionExtractorRunner("T6b", extractor, false);
    },
  },
  {
    id: "T6c",
    networkRequired: true,
    build: async () => {
      const apiKey = process.env.GOOGLE_API_KEY;
      if (!apiKey) {
        throw new Error(
          "T6c requires GOOGLE_API_KEY (Gemini 2.5 Pro Vision). Set it in .env.local.",
        );
      }
      let mod: { GeminiProExtractor: new (opts: { apiKey: string }) => Extractor };
      try {
        mod = (await import("../src/lib/vision/gemini")) as typeof mod;
      } catch (err) {
        throw new Error(
          `T6c extractor module not available: ${(err as Error).message}. ` +
            `Expected src/lib/vision/gemini.ts to export GeminiProExtractor.`,
        );
      }
      const extractor = new mod.GeminiProExtractor({ apiKey });
      return new VisionExtractorRunner("T6c", extractor, false);
    },
  },
  // ─── Frontier 2026 candidates (T6d / T6e / T7 / T7b / T8 / T9 / T10 /
  // T11 / T12) ──────────────────────────────────────────────────────────────
  //
  // The user's intelligence-first priority calls for the bake-off to cover
  // the 2026 frontier across every major provider — not just the
  // Gemini/GPT-4o/Sonnet trio. These factories route through OpenRouter
  // (https://openrouter.ai), which proxies dozens of providers behind an
  // OpenAI-compatible API and is reachable with the existing `openai`
  // dependency. Each factory hard-codes the per-1M token pricing the
  // caller saw on OpenRouter's published table at the user's knowledge
  // cutoff (2026-05); a comment flags any rate that's an estimate.
  //
  // Model availability caveat: OpenRouter's catalogue moves faster than
  // this file. If a slug is renamed or paused upstream the build() call
  // will surface OpenRouter's 404 body verbatim; that's the right failure
  // mode — we want the operator to update the slug, not silently substitute.
  // ──────────────────────────────────────────────────────────────────────
  {
    // T6d — Gemini 3 Pro (frontier Google tier). Prefer direct Google SDK
    // by bumping GeminiProExtractor's modelVersion if the env hints the
    // direct path is available; otherwise route via OpenRouter so the
    // candidate is testable even before @google/generative-ai catches up
    // to the gemini-3-* line.
    id: "T6d",
    networkRequired: true,
    build: async () => {
      const directKey = process.env.GOOGLE_API_KEY;
      const routerKey = process.env.OPENROUTER_API_KEY;
      // Direct Google SDK path: only taken if the operator explicitly opts
      // in (MODEL_GEMINI_3_DIRECT=1). The SDK may still 404 on the slug at
      // any moment, so the OpenRouter fallback below is the safer default.
      if (directKey && process.env.MODEL_GEMINI_3_DIRECT === "1") {
        let mod: {
          GeminiProExtractor: new (opts: {
            apiKey: string;
            modelVersion?: string;
          }) => Extractor;
        };
        try {
          mod = (await import("../src/lib/vision/gemini")) as typeof mod;
        } catch (err) {
          throw new Error(
            `T6d extractor module not available: ${(err as Error).message}. ` +
              `Expected src/lib/vision/gemini.ts to export GeminiProExtractor.`,
          );
        }
        const extractor = new mod.GeminiProExtractor({
          apiKey: directKey,
          modelVersion: process.env.MODEL_GEMINI_3_PRO ?? "gemini-3-pro-preview",
        });
        return new VisionExtractorRunner("T6d", extractor, false);
      }
      if (!routerKey) {
        throw new Error(
          "T6d requires OPENROUTER_API_KEY (Gemini 3 Pro via OpenRouter). " +
            "Or set GOOGLE_API_KEY + MODEL_GEMINI_3_DIRECT=1 to use the " +
            "direct Google SDK path if Gemini 3.x is reachable there.",
        );
      }
      let mod: {
        OpenRouterExtractor: new (opts: {
          apiKey: string;
          modelSlug: string;
          pricing: { inputPer1M: number; outputPer1M: number };
          structuredOutput?: boolean;
        }) => Extractor;
      };
      try {
        mod = (await import("../src/lib/vision/openrouter")) as typeof mod;
      } catch (err) {
        throw new Error(
          `T6d extractor module not available: ${(err as Error).message}. ` +
            `Expected src/lib/vision/openrouter.ts to export OpenRouterExtractor.`,
        );
      }
      // Estimated pricing — refresh from https://openrouter.ai/google/gemini-3-pro-preview
      // when the public listing lands.
      const extractor = new mod.OpenRouterExtractor({
        apiKey: routerKey,
        modelSlug: "google/gemini-3.1-pro-preview",
        pricing: { inputPer1M: 2.0, outputPer1M: 12.0 },
        structuredOutput: true,
      });
      return new VisionExtractorRunner("T6d", extractor, false);
    },
  },
  {
    // T6e — Gemini 3.1 Flash Lite GA (cheap & fast frontier Google tier).
    // Routed via OpenRouter for apples-to-apples cost accounting against
    // the other OpenRouter contenders. The Google-SDK direct path uses the
    // same model in `gemini.ts` (T6).
    id: "T6e",
    networkRequired: true,
    build: async () => {
      const apiKey = process.env.OPENROUTER_API_KEY;
      if (!apiKey) {
        throw new Error(
          "T6e requires OPENROUTER_API_KEY (Gemini 3.1 Flash Lite via OpenRouter). " +
            "See https://openrouter.ai/models for the current slug.",
        );
      }
      let mod: {
        OpenRouterExtractor: new (opts: {
          apiKey: string;
          modelSlug: string;
          pricing: { inputPer1M: number; outputPer1M: number };
          structuredOutput?: boolean;
        }) => Extractor;
      };
      try {
        mod = (await import("../src/lib/vision/openrouter")) as typeof mod;
      } catch (err) {
        throw new Error(
          `T6e extractor module not available: ${(err as Error).message}. ` +
            `Expected src/lib/vision/openrouter.ts to export OpenRouterExtractor.`,
        );
      }
      const extractor = new mod.OpenRouterExtractor({
        apiKey,
        modelSlug: "google/gemini-3.1-flash-lite",
        pricing: { inputPer1M: 0.25, outputPer1M: 1.5 },
        structuredOutput: true,
      });
      return new VisionExtractorRunner("T6e", extractor, false);
    },
  },
  {
    // T7 — GPT-5 (OpenAI frontier). Routed via OpenRouter since the direct
    // openai SDK may lag on the gpt-5 model slug at the user's cutoff;
    // bumping the GPT4oFullExtractor default would silently break callers
    // still on gpt-4o, so a separate technique ID is the safer wiring.
    id: "T7",
    networkRequired: true,
    build: async () => {
      const apiKey = process.env.OPENROUTER_API_KEY;
      if (!apiKey) {
        throw new Error(
          "T7 requires OPENROUTER_API_KEY (GPT-5 via OpenRouter). " +
            "See https://openrouter.ai/openai/gpt-5 for the current slug + pricing.",
        );
      }
      let mod: {
        OpenRouterExtractor: new (opts: {
          apiKey: string;
          modelSlug: string;
          pricing: { inputPer1M: number; outputPer1M: number };
          structuredOutput?: boolean;
        }) => Extractor;
      };
      try {
        mod = (await import("../src/lib/vision/openrouter")) as typeof mod;
      } catch (err) {
        throw new Error(
          `T7 extractor module not available: ${(err as Error).message}. ` +
            `Expected src/lib/vision/openrouter.ts to export OpenRouterExtractor.`,
        );
      }
      const extractor = new mod.OpenRouterExtractor({
        apiKey,
        // GPT-5.5 is OpenAI's current flagship vision tier (created
        // 2026-04-24 on OpenRouter). Pricing pulled from OpenRouter's live
        // model listing.
        modelSlug: "openai/gpt-5.5",
        pricing: { inputPer1M: 5, outputPer1M: 30 },
        structuredOutput: true,
      });
      return new VisionExtractorRunner("T7", extractor, false);
    },
  },
  {
    // T7b — GPT-5.4 nano (OpenAI's smallest current vision tier — created
    // 2026-03-17 on OpenRouter). Older 5-nano/5-mini are still on the
    // catalog but at notably worse cost/perf vs the 5.4 line.
    id: "T7b",
    networkRequired: true,
    build: async () => {
      const apiKey = process.env.OPENROUTER_API_KEY;
      if (!apiKey) {
        throw new Error(
          "T7b requires OPENROUTER_API_KEY (GPT-5.4-nano via OpenRouter). " +
            "See https://openrouter.ai/openai/gpt-5.4-nano for the current slug + pricing.",
        );
      }
      let mod: {
        OpenRouterExtractor: new (opts: {
          apiKey: string;
          modelSlug: string;
          pricing: { inputPer1M: number; outputPer1M: number };
          structuredOutput?: boolean;
        }) => Extractor;
      };
      try {
        mod = (await import("../src/lib/vision/openrouter")) as typeof mod;
      } catch (err) {
        throw new Error(
          `T7b extractor module not available: ${(err as Error).message}. ` +
            `Expected src/lib/vision/openrouter.ts to export OpenRouterExtractor.`,
        );
      }
      const extractor = new mod.OpenRouterExtractor({
        apiKey,
        modelSlug: "openai/gpt-5.4-nano",
        pricing: { inputPer1M: 0.2, outputPer1M: 1.25 },
        structuredOutput: true,
      });
      return new VisionExtractorRunner("T7b", extractor, false);
    },
  },
  {
    // T8 — Mistral Medium 3.5 (Mistral's current flagship vision tier,
    // created 2026-04-30 on OpenRouter). The older Pixtral Large slug
    // disappeared from the OpenRouter catalogue, so this is the natural
    // successor; mistral-medium-3-5 is multimodal and structured-output
    // capable via OpenAI-compat tools.
    id: "T8",
    networkRequired: true,
    build: async () => {
      const apiKey = process.env.OPENROUTER_API_KEY;
      if (!apiKey) {
        throw new Error(
          "T8 requires OPENROUTER_API_KEY (Mistral Medium 3.5 via OpenRouter). " +
            "See https://openrouter.ai/mistralai/mistral-medium-3-5 for the current slug.",
        );
      }
      let mod: {
        OpenRouterExtractor: new (opts: {
          apiKey: string;
          modelSlug: string;
          pricing: { inputPer1M: number; outputPer1M: number };
          structuredOutput?: boolean;
        }) => Extractor;
      };
      try {
        mod = (await import("../src/lib/vision/openrouter")) as typeof mod;
      } catch (err) {
        throw new Error(
          `T8 extractor module not available: ${(err as Error).message}. ` +
            `Expected src/lib/vision/openrouter.ts to export OpenRouterExtractor.`,
        );
      }
      const extractor = new mod.OpenRouterExtractor({
        apiKey,
        modelSlug: "mistralai/mistral-medium-3-5",
        pricing: { inputPer1M: 1.5, outputPer1M: 7.5 },
        structuredOutput: false,
      });
      return new VisionExtractorRunner("T8", extractor, false);
    },
  },
  {
    // T9 — NVIDIA Nemotron 3 Nano Omni 30B (reasoning, vision, free tier).
    // Created 2026-04-28 on OpenRouter and priced at $0 — the best
    // free-tier vision-reasoning model available. Free tier is
    // rate-limited but fine for an 90-image × 3-trial bake-off.
    id: "T9",
    networkRequired: true,
    build: async () => {
      const apiKey = process.env.OPENROUTER_API_KEY;
      if (!apiKey) {
        throw new Error(
          "T9 requires OPENROUTER_API_KEY (NVIDIA Nemotron 3 Nano Omni via OpenRouter). " +
            "See https://openrouter.ai/models?q=nemotron for the current slug.",
        );
      }
      let mod: {
        OpenRouterExtractor: new (opts: {
          apiKey: string;
          modelSlug: string;
          pricing: { inputPer1M: number; outputPer1M: number };
          structuredOutput?: boolean;
        }) => Extractor;
      };
      try {
        mod = (await import("../src/lib/vision/openrouter")) as typeof mod;
      } catch (err) {
        throw new Error(
          `T9 extractor module not available: ${(err as Error).message}. ` +
            `Expected src/lib/vision/openrouter.ts to export OpenRouterExtractor.`,
        );
      }
      const extractor = new mod.OpenRouterExtractor({
        apiKey,
        modelSlug: "nvidia/nemotron-3-nano-omni-30b-a3b-reasoning:free",
        pricing: { inputPer1M: 0, outputPer1M: 0 },
        structuredOutput: false,
      });
      return new VisionExtractorRunner("T9", extractor, false);
    },
  },
  {
    // T10 — Qwen 3.6 Flash (Alibaba's current flash-tier vision model,
    // created 2026-04-27 on OpenRouter). High-value to test as a non-US
    // contender at GPT-5.4-nano-class pricing.
    id: "T10",
    networkRequired: true,
    build: async () => {
      const apiKey = process.env.OPENROUTER_API_KEY;
      if (!apiKey) {
        throw new Error(
          "T10 requires OPENROUTER_API_KEY (Qwen 3.6 Flash via OpenRouter). " +
            "See https://openrouter.ai/qwen/qwen3.6-flash for the current slug.",
        );
      }
      let mod: {
        OpenRouterExtractor: new (opts: {
          apiKey: string;
          modelSlug: string;
          pricing: { inputPer1M: number; outputPer1M: number };
          structuredOutput?: boolean;
        }) => Extractor;
      };
      try {
        mod = (await import("../src/lib/vision/openrouter")) as typeof mod;
      } catch (err) {
        throw new Error(
          `T10 extractor module not available: ${(err as Error).message}. ` +
            `Expected src/lib/vision/openrouter.ts to export OpenRouterExtractor.`,
        );
      }
      const extractor = new mod.OpenRouterExtractor({
        apiKey,
        modelSlug: "qwen/qwen3.6-flash",
        pricing: { inputPer1M: 0.25, outputPer1M: 1.5 },
        structuredOutput: false,
      });
      return new VisionExtractorRunner("T10", extractor, false);
    },
  },
  {
    // T11 — Llama 4 Maverick (Meta's current open-weight vision tier,
    // created 2025-04-05 on OpenRouter; Llama 4 Scout is the cheaper
    // sibling). Older Llama 3.2 90B Vision slug is gone from the
    // catalogue — Maverick is the natural successor.
    id: "T11",
    networkRequired: true,
    build: async () => {
      const apiKey = process.env.OPENROUTER_API_KEY;
      if (!apiKey) {
        throw new Error(
          "T11 requires OPENROUTER_API_KEY (Llama 4 Maverick via OpenRouter). " +
            "See https://openrouter.ai/meta-llama/llama-4-maverick for the current slug.",
        );
      }
      let mod: {
        OpenRouterExtractor: new (opts: {
          apiKey: string;
          modelSlug: string;
          pricing: { inputPer1M: number; outputPer1M: number };
          structuredOutput?: boolean;
        }) => Extractor;
      };
      try {
        mod = (await import("../src/lib/vision/openrouter")) as typeof mod;
      } catch (err) {
        throw new Error(
          `T11 extractor module not available: ${(err as Error).message}. ` +
            `Expected src/lib/vision/openrouter.ts to export OpenRouterExtractor.`,
        );
      }
      const extractor = new mod.OpenRouterExtractor({
        apiKey,
        modelSlug: "meta-llama/llama-4-maverick",
        pricing: { inputPer1M: 0.15, outputPer1M: 0.6 },
        structuredOutput: false,
      });
      return new VisionExtractorRunner("T11", extractor, false);
    },
  },
  {
    // T12 — Claude Opus 4.7 (Anthropic's current frontier vision tier —
    // created 2026-04-16 on OpenRouter, $5/$25 per 1M). We prefer the
    // direct Anthropic SDK path when ANTHROPIC_API_KEY is set; fall back
    // to OpenRouter so the bake-off still runs with consolidated billing.
    id: "T12",
    networkRequired: true,
    build: async () => {
      const directKey = process.env.ANTHROPIC_API_KEY;
      const routerKey = process.env.OPENROUTER_API_KEY;
      // Same preference logic as T5b — let the operator force the
      // OpenRouter path when the direct Anthropic key is rotten.
      const preferRouter =
        process.env.ANTHROPIC_USE_OPENROUTER === "1" ||
        (routerKey && !directKey);
      if (directKey && !preferRouter) {
        let mod: {
          ClaudeOpusExtractor: new (opts: {
            apiKey: string;
            modelVersion?: string;
          }) => Extractor;
        };
        try {
          mod = (await import("../src/lib/vision/anthropic")) as typeof mod;
        } catch (err) {
          throw new Error(
            `T12 extractor module not available: ${(err as Error).message}. ` +
              `Expected src/lib/vision/anthropic.ts to export ClaudeOpusExtractor.`,
          );
        }
        const extractor = new mod.ClaudeOpusExtractor({
          apiKey: directKey,
          modelVersion: process.env.MODEL_CLAUDE_OPUS ?? "claude-opus-4-7",
        });
        return new VisionExtractorRunner("T12", extractor, false);
      }
      if (!routerKey) {
        throw new Error(
          "T12 requires ANTHROPIC_API_KEY (direct, preferred) or " +
            "OPENROUTER_API_KEY (proxied via OpenRouter). Set one in .env.local.",
        );
      }
      let mod: {
        OpenRouterExtractor: new (opts: {
          apiKey: string;
          modelSlug: string;
          pricing: { inputPer1M: number; outputPer1M: number };
          structuredOutput?: boolean;
        }) => Extractor;
      };
      try {
        mod = (await import("../src/lib/vision/openrouter")) as typeof mod;
      } catch (err) {
        throw new Error(
          `T12 extractor module not available: ${(err as Error).message}. ` +
            `Expected src/lib/vision/openrouter.ts to export OpenRouterExtractor.`,
        );
      }
      const extractor = new mod.OpenRouterExtractor({
        apiKey: routerKey,
        modelSlug: "anthropic/claude-opus-4.7",
        pricing: { inputPer1M: 5, outputPer1M: 25 },
        structuredOutput: false,
      });
      return new VisionExtractorRunner("T12", extractor, false);
    },
  },
];

export function findTechnique(id: string): TechniqueFactory | undefined {
  return BUILTIN_TECHNIQUES.find((t) => t.id === id);
}
