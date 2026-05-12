// ─── Multi-model selectable modes ──────────────────────────────────────────
//
// Declarative catalogue of extractor "modes" the verifier can use. The
// public UI no longer surfaces a mode picker (the routine bake-off in
// docs/MODEL-SELECTION.md §4 showed three of the five offered modes
// were strictly worse than the default on the corpus, so the picker
// was retired — see src/app/page.tsx). The catalogue is retained for:
//   - benchmark harness selection (benchmarks/run.ts --mode=…)
//   - the optional /api/verify?mode= query parameter for operators
//     running internal A/B tests
//
// The list is intentionally short and human-readable; the full
// provider matrix lives in benchmarks/techniques.ts.
//
// Each mode owns:
//   - a stable `id` (persisted in localStorage as `labelverify:mode`)
//   - human-readable copy (`label`, `description`)
//   - a *lazy* `extractorFactory()` so we don't pay any API-key reads or
//     SDK instantiation cost at module-load — only when the mode is chosen
//   - display-only `approxCostPer1k` and `approxLatency` so the UI can show
//     budget hints without us pretending to compute them per-request
//
// Why a separate file from `vision/index.ts`: the vision barrel is the
// adapter layer (one class per provider). This file curates *user-facing
// presets* across those adapters — adding/removing a mode here doesn't
// touch the adapters.
//
// Client-bundle hygiene: this module is intentionally `import type`-only at
// the top level, and the extractor wrapper classes defer their heavy
// dependencies (vision adapters, tesseract.js) to dynamic `import()` calls
// inside `extract()`. Importing this catalogue from a client component
// (if a future feature reintroduces a mode picker) won't drag the
// OCR/SDK bundles into the browser build.

import type {
  ExtractedFields,
  Extractor,
  ExtractorContext,
  ExtractorResult,
} from "./vision/types";

export type ModelModeId =
  | "default"
  | "fast"
  | "smart"
  | "local"
  | "balanced";

export interface ModelMode {
  /** Stable ID — persisted to localStorage. Do not rename without a migration. */
  readonly id: ModelModeId;
  /** Short human label shown in the radio list and inline next to "Settings". */
  readonly label: string;
  /** One-line UX hint shown under the label in the expanded panel. */
  readonly description: string;
  /** Lazy: builds (and caches once per mode) the underlying Extractor. */
  readonly extractorFactory: () => Extractor;
  /** True if the mode needs network access (most modes do; "local" doesn't). */
  readonly networkRequired: boolean;
  /** Approximate cost per 1k labels, for display only. */
  readonly approxCostPer1k: string;
  /** Approximate P50 latency, for display only. */
  readonly approxLatency: string;
}

// ─── Deferred extractor wrappers ────────────────────────────────────────────
//
// Each wrapper holds its options and lazily loads the underlying adapter the
// first time `extract()` runs. The inner extractor instance is memoised on
// the wrapper. We don't reach for the env vars (process.env.GOOGLE_API_KEY)
// or instantiate any SDK clients until we actually need them — so building
// the MODES catalogue itself is free at module-load.

class DeferredGeminiFlash implements Extractor {
  readonly id = "gemini-flash:deferred";
  readonly networkRequired = true;
  private inner: Extractor | null = null;

  constructor(private readonly modelVersion?: string) {}

  async extract(
    image: Buffer,
    ctx?: ExtractorContext,
  ): Promise<ExtractorResult> {
    if (!this.inner) {
      const apiKey = process.env.GOOGLE_API_KEY;
      if (!apiKey) {
        throw new Error(
          "model-modes: GOOGLE_API_KEY is not set. Required for Gemini-backed modes.",
        );
      }
      const mod = await import("./vision/gemini");
      this.inner = new mod.GeminiFlashExtractor(
        this.modelVersion === undefined
          ? { apiKey }
          : { apiKey, modelVersion: this.modelVersion },
      );
    }
    return this.inner.extract(image, ctx);
  }
}

class DeferredGeminiPro implements Extractor {
  readonly id = "gemini-pro:deferred";
  readonly networkRequired = true;
  private inner: Extractor | null = null;

  async extract(
    image: Buffer,
    ctx?: ExtractorContext,
  ): Promise<ExtractorResult> {
    if (!this.inner) {
      const apiKey = process.env.GOOGLE_API_KEY;
      if (!apiKey) {
        throw new Error(
          "model-modes: GOOGLE_API_KEY is not set. Required for the 'smart' mode.",
        );
      }
      const mod = await import("./vision/gemini");
      this.inner = new mod.GeminiProExtractor({ apiKey });
    }
    return this.inner.extract(image, ctx);
  }
}

class DeferredBalanced implements Extractor {
  // The id, networkRequired and underlying SUM-of-latencies behaviour all
  // come from TieredEscalationExtractor once it's loaded. We expose stable
  // surface fields here so the orchestrator can read them up-front.
  readonly id = "balanced:deferred";
  readonly networkRequired = true;
  private inner: Extractor | null = null;

  async extract(
    image: Buffer,
    ctx?: ExtractorContext,
  ): Promise<ExtractorResult> {
    if (!this.inner) {
      const apiKey = process.env.GOOGLE_API_KEY;
      if (!apiKey) {
        throw new Error(
          "model-modes: GOOGLE_API_KEY is not set. Required for the 'balanced' mode.",
        );
      }
      const [gemini, tiered] = await Promise.all([
        import("./vision/gemini"),
        import("./vision/tiered"),
      ]);
      this.inner = new tiered.TieredEscalationExtractor({
        fast: new gemini.GeminiFlashExtractor({ apiKey }),
        strong: new gemini.GeminiProExtractor({ apiKey }),
      });
    }
    return this.inner.extract(image, ctx);
  }
}

// ─── TesseractOnlyExtractor (the "local" mode) ──────────────────────────────
//
// Tesseract-only path: no vision API call, no API key, no network. We
// re-use the same OCR worker (tesseractEngine) the main pipeline already
// uses for OCR-hint priming, then apply the same regex/heuristic field
// extraction as `benchmarks/techniques.ts TesseractOnlyRunner` — kept
// in-file (not imported from benchmarks/) because the benchmarks tree is
// out of scope for production bundling. The implementation here is a
// deliberately minimal best-effort that fills what Tesseract can read and
// leaves the rest at null with confidence 0; downstream comparators then
// produce REVIEW/FAIL exactly as they would for any low-confidence
// extraction. The fixed OCR confidence (0.4) mirrors the bench's choice
// for the same reason: this is OCR-only, no semantic understanding.

const LOCAL_OCR_FIELD_CONFIDENCE = 0.4;

const LOCAL_ABV_PATTERNS: RegExp[] = [
  /(\d+(?:[.,]\d+)?)\s*%?\s*(?:alc(?:ohol)?\.?\s*\/?\s*vol|alc\.?\s*by\s*vol|abv|vol)/i,
  /(?:alc(?:ohol)?\.?\s*\/?\s*vol|alc\.?\s*by\s*vol|abv)\s*[:\s]*?(\d+(?:[.,]\d+)?)\s*%?/i,
  /(\d+(?:[.,]\d+)?)\s*%\s*alc/i,
];

const LOCAL_NET_PATTERNS: ReadonlyArray<{
  re: RegExp;
  unit: "ml" | "fl_oz" | "L" | "cl";
}> = [
  { re: /(\d+(?:[.,]\d+)?)\s*ml\b/i, unit: "ml" },
  { re: /(\d+(?:[.,]\d+)?)\s*cl\b/i, unit: "cl" },
  { re: /(\d+(?:[.,]\d+)?)\s*l\b(?!\w)/i, unit: "L" },
  { re: /(\d+(?:[.,]\d+)?)\s*fl\.?\s*oz\b/i, unit: "fl_oz" },
];

const LOCAL_KNOWN_COUNTRIES: ReadonlyArray<{
  token: string;
  canonical: string;
}> = [
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

const LOCAL_STYLE_TOKENS: readonly string[] = [
  "IPA",
  "LAGER",
  "PILSNER",
  "PALE ALE",
  "WHEAT BEER",
  "STOUT",
  "PORTER",
  "SAISON",
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
];

function parseNumberLoose(s: string): number | null {
  const n = Number(s.replace(",", "."));
  return Number.isFinite(n) ? n : null;
}

function extractAbv(text: string): number | null {
  for (const re of LOCAL_ABV_PATTERNS) {
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
  for (const { re, unit } of LOCAL_NET_PATTERNS) {
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
  const productOf = upper.match(
    /(?:PRODUCT\s+OF|PRODUCED\s+IN|BOTTLED\s+IN|MADE\s+IN)\s+([A-Z][A-Z .'-]{2,30})/,
  );
  if (productOf && productOf[1]) {
    const tail = productOf[1].trim().replace(/[.,].*$/, "").trim();
    for (const { token, canonical } of LOCAL_KNOWN_COUNTRIES) {
      if (tail.includes(token)) return canonical;
    }
  }
  for (const { token, canonical } of LOCAL_KNOWN_COUNTRIES) {
    if (upper.includes(token)) return canonical;
  }
  return null;
}

function extractClassType(text: string): string | null {
  const upper = text.toUpperCase();
  const matches = LOCAL_STYLE_TOKENS.filter((t) => upper.includes(t)).sort(
    (a, b) => b.length - a.length,
  );
  return matches[0] ?? null;
}

function extractBrand(text: string): string | null {
  const lines = text
    .split(/\r?\n/)
    .map((l) => l.trim())
    .filter(Boolean);
  for (const line of lines.slice(0, 8)) {
    const upper = line.toUpperCase();
    if (upper.startsWith("GOVERNMENT WARNING")) continue;
    if (LOCAL_NET_PATTERNS.some((p) => p.re.test(line))) continue;
    if (LOCAL_ABV_PATTERNS.some((p) => p.test(line))) continue;
    const letters = line.replace(/[^A-Za-z]/g, "");
    if (letters.length < 3) continue;
    if (!/[A-Z]{3,}/.test(line)) {
      if (!/^[A-Z][a-z]+(?:\s+[A-Z][a-z]+)*$/.test(line)) continue;
    }
    const cleaned = line.replace(/[^\p{L}\p{N}'.\s&-]/gu, "").trim();
    return cleaned.length > 0 ? cleaned : null;
  }
  return null;
}

function extractGovernmentWarning(text: string): {
  raw_text: string | null;
  prefix_text: string | null;
} {
  const idx = text.search(/GOVERNMENT\s+WARNING/i);
  if (idx < 0) return { raw_text: null, prefix_text: null };
  const tail = text.slice(idx);
  const end = tail.search(/\n\s*\n/);
  const raw = (end >= 0 ? tail.slice(0, end) : tail).trim();
  const colon = raw.indexOf(":");
  const prefix =
    colon > 0
      ? raw.slice(0, colon + 1).trim()
      : raw.split(/\s+/).slice(0, 2).join(" ");
  return { raw_text: raw, prefix_text: prefix };
}

function emptyExtractedFields(): ExtractedFields {
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

/**
 * Tesseract-only extractor. No vision API, no network, no API keys —
 * intended for the "local" mode and as a graceful fallback when the
 * operator can't or won't configure a cloud key. Loads tesseract.js
 * lazily so the client bundle doesn't pull it in.
 */
class TesseractOnlyExtractor implements Extractor {
  readonly id = "tesseract-only";
  readonly networkRequired = false;

  async extract(
    image: Buffer,
    ctx?: ExtractorContext,
  ): Promise<ExtractorResult> {
    const start = performance.now();
    // If the orchestrator already kicked off an OCR pass and handed us
    // the text via ctx.ocrText, reuse it — skip the second Tesseract
    // round-trip. Otherwise dynamic-import the engine and run it ourselves.
    let text: string;
    if (typeof ctx?.ocrText === "string" && ctx.ocrText.length > 0) {
      text = ctx.ocrText;
    } else {
      const ocrMod = await import("./ocr/tesseract");
      const r = await ocrMod.tesseractEngine.run(image, ctx?.signal);
      text = r.text;
    }

    const promptMod = await import("./vision/prompt");

    const fields = emptyExtractedFields();

    const brand = extractBrand(text);
    if (brand) {
      fields.brand_name = {
        value: brand,
        confidence: LOCAL_OCR_FIELD_CONFIDENCE,
      };
    }
    const cls = extractClassType(text);
    if (cls) {
      fields.class_type = {
        value: cls,
        confidence: LOCAL_OCR_FIELD_CONFIDENCE,
      };
    }
    const abv = extractAbv(text);
    if (abv !== null) {
      fields.abv_percent = {
        value: abv,
        confidence: LOCAL_OCR_FIELD_CONFIDENCE,
      };
    }
    const nc = extractNetContents(text);
    if (nc) {
      fields.net_contents = {
        value: nc,
        confidence: LOCAL_OCR_FIELD_CONFIDENCE,
      };
    }
    const country = extractCountry(text);
    if (country) {
      fields.country_of_origin = {
        value: country,
        confidence: LOCAL_OCR_FIELD_CONFIDENCE,
      };
    }
    const gw = extractGovernmentWarning(text);
    fields.government_warning = {
      value: {
        raw_text: gw.raw_text,
        prefix_text: gw.prefix_text,
        prefix_bbox: null,
        prefix_appears_bold: null,
        prefix_appears_caps:
          gw.prefix_text === null
            ? null
            : gw.prefix_text === gw.prefix_text.toUpperCase(),
      },
      confidence: gw.raw_text ? LOCAL_OCR_FIELD_CONFIDENCE : 0,
    };

    return {
      fields,
      rawOutput: { source: "tesseract-only", text },
      latencyMs: performance.now() - start,
      modelId: this.id,
      modelVersion: "tesseract",
      promptHash: promptMod.getPromptHash(),
      cost: { inputTokens: 0, outputTokens: 0, costUsd: 0 },
    };
  }
}

// ─── Mode catalogue ─────────────────────────────────────────────────────────

const cache = new Map<ModelModeId, Extractor>();
function cached(id: ModelModeId, build: () => Extractor): () => Extractor {
  return () => {
    const hit = cache.get(id);
    if (hit) return hit;
    const built = build();
    cache.set(id, built);
    return built;
  };
}

export const MODES: readonly ModelMode[] = [
  {
    id: "default",
    label: "Default",
    description: "Recommended. Uses the MODEL_PRIMARY setting on the server.",
    extractorFactory: cached(
      "default",
      () => new DeferredGeminiFlash(process.env.MODEL_PRIMARY),
    ),
    networkRequired: true,
    approxCostPer1k: "~$0.10",
    approxLatency: "~2s P50",
  },
  {
    id: "fast",
    label: "Fast",
    description: "Fastest, cheapest, very capable. Gemini Flash Lite.",
    extractorFactory: cached("fast", () => new DeferredGeminiFlash()),
    networkRequired: true,
    approxCostPer1k: "~$0.08",
    approxLatency: "~2s P50",
  },
  {
    id: "smart",
    label: "Smart",
    description: "Most accurate, slower, costlier. Gemini Pro Preview.",
    extractorFactory: cached("smart", () => new DeferredGeminiPro()),
    networkRequired: true,
    approxCostPer1k: "~$1.80",
    approxLatency: "~5s P50",
  },
  {
    id: "local",
    label: "Local",
    description: "Network-free fallback. Tesseract OCR only, no vision API.",
    extractorFactory: cached("local", () => new TesseractOnlyExtractor()),
    networkRequired: false,
    approxCostPer1k: "$0.00",
    approxLatency: "~1.5s P50",
  },
  {
    id: "balanced",
    label: "Balanced",
    description:
      "Recommended for production: catches edge cases. Fast first, escalates to Smart on low confidence.",
    extractorFactory: cached("balanced", () => new DeferredBalanced()),
    networkRequired: true,
    approxCostPer1k: "~$0.20",
    approxLatency: "~3s P50",
  },
] as const;

/** Look up a mode by ID. Returns undefined for unknown IDs (do not throw — the
 * caller is often handling user-supplied input from a form/localStorage). */
export function getMode(id: string): ModelMode | undefined {
  return MODES.find((m) => m.id === id);
}

/** Default mode ID when nothing is selected. */
export const DEFAULT_MODE_ID: ModelModeId = "default";
