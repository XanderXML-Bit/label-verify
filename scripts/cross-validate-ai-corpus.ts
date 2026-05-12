// Cross-validate the AI-generated corpus ground truth at
// test-data/ai-generated/ground-truth/*.json against an oracle vision
// pass (Gemini 3.1 Pro Preview). The script does NOT touch the corpus —
// it only reads images + ground truth, runs the strongest extractor over
// each, and emits two artefacts under .review/:
//
//   .review/ai-corpus-cross-validation.md   (human-readable)
//   .review/ai-corpus-cross-validation.json (machine-readable)
//
// CLI:
//   tsx scripts/cross-validate-ai-corpus.ts            # all 50
//   tsx scripts/cross-validate-ai-corpus.ts --limit 5  # first 5
//   tsx scripts/cross-validate-ai-corpus.ts --id ai-label-0001
//
// Throttling: sequential, 1 image at a time, ~1s spacing between calls.
// Per-image timeout: 30s (race against an AbortSignal).
//
// The diff rules implement the spec from the parent task:
//   brand_name             fuzzy (Levenshtein ≥ 0.9 OR token-set ≥ 0.85)
//   class_type             alias-aware + fuzzy ≥ 0.85
//   abv_percent            within 0.2 pp absolute
//   net_contents           ±1 ml after unit conversion
//   country_of_origin      alias-aware (USA ≡ United States)
//   government_warning.present                  boolean
//   government_warning.text_matches_regulation  boolean against the canonical text
//   producer.name          fuzzy

import { readFile, readdir, writeFile, mkdir } from "node:fs/promises";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { fuzzy as ratio } from "fast-fuzzy";
import { preprocessImage } from "../src/lib/preprocess";
import { GeminiProExtractor } from "../src/lib/vision/gemini";
import type { ExtractedFields, NetContents } from "../src/lib/vision/types";
import {
  canonicalStatement,
  GOVERNMENT_WARNING_BODY,
} from "../src/lib/validation/government-warning";

// ─── Tiny .env.local loader (no extra deps) ─────────────────────────────────
// We don't shell out to dotenv-cli because it isn't installed. Parse the
// file ourselves: KEY=VALUE lines, ignore comments and blanks, strip
// matching surrounding quotes. Silently no-op if the file is absent.
function loadDotenv(path: string): void {
  if (!existsSync(path)) return;
  const text = readFileSync(path, "utf8");
  for (const raw of text.split(/\r?\n/)) {
    const line = raw.trim();
    if (!line || line.startsWith("#")) continue;
    const eq = line.indexOf("=");
    if (eq < 0) continue;
    const k = line.slice(0, eq).trim();
    let v = line.slice(eq + 1).trim();
    if (
      (v.startsWith('"') && v.endsWith('"')) ||
      (v.startsWith("'") && v.endsWith("'"))
    ) {
      v = v.slice(1, -1);
    }
    if (!(k in process.env)) process.env[k] = v;
  }
}

// ─── Types from ground-truth JSON ───────────────────────────────────────────

interface GroundTruthPromptFields {
  brandName: string;
  classType: string;
  alcoholByVolume: string; // "5.2%"
  netContents: string; // "12 FL OZ", "750 mL", "1 PT 0 FL OZ" etc.
  producerAddress: string;
  // Some entries deliberately set this to null when no country of origin
  // is visible on the label (Codex's audit noted these as
  // "prompt-intended but not visually confirmed").
  countryOfOrigin: string | null;
  governmentWarning: string | null;
}

interface GroundTruth {
  id: string;
  image: string;
  format: string;
  beverageType: string;
  intendedCompliance: string;
  warningCase: string | null;
  promptDeclaredFields: GroundTruthPromptFields;
  expectedFields: GroundTruthPromptFields;
  visualAudit?: {
    usageTier?: string;
    strictBenchmarkReady?: boolean;
  };
}

interface Diff {
  field: string;
  expected: unknown;
  actual: unknown;
  reason: string;
}

type Status = "match" | "drift" | "error";

interface ImageReport {
  id: string;
  status: Status;
  usageTier: string | undefined;
  diffs: Diff[];
  extractorRaw: ExtractedFields | null;
  extractorError?: string;
  latencyMs?: number;
  costUsd?: number;
  inputTokens?: number;
  outputTokens?: number;
}

// ─── Field comparators ──────────────────────────────────────────────────────

function normalizeText(s: string): string {
  return s
    .normalize("NFKC")
    .replace(/[‘’‚‛]/g, "'")
    .replace(/[“”„‟]/g, '"')
    .toLowerCase()
    .replace(/[^\p{L}\p{N}'\s]/gu, " ")
    .replace(/\s+/g, " ")
    .trim();
}

function tokenSetRatio(a: string, b: string): number {
  const ta = new Set(a.split(" ").filter(Boolean));
  const tb = new Set(b.split(" ").filter(Boolean));
  const inter = new Set<string>();
  for (const t of ta) if (tb.has(t)) inter.add(t);
  const sorted = [...inter].sort().join(" ");
  const restA = [...ta].filter((t) => !inter.has(t)).sort().join(" ");
  const restB = [...tb].filter((t) => !inter.has(t)).sort().join(" ");
  const t0 = sorted;
  const t1 = (sorted + " " + restA).trim();
  const t2 = (sorted + " " + restB).trim();
  return Math.max(ratio(t0, t1), ratio(t0, t2), ratio(t1, t2));
}

function fuzzyMatch(
  expected: string,
  actual: string,
  levMin = 0.9,
  tokMin = 0.85,
): { ok: boolean; lev: number; tok: number } {
  const a = normalizeText(expected);
  const b = normalizeText(actual);
  const lev = ratio(a, b);
  const tok = tokenSetRatio(a, b);
  return { ok: lev >= levMin || tok >= tokMin, lev, tok };
}

// Class-type alias canonicalization. Mirrors src/lib/matching/class.ts;
// duplicated here so this oracle pass is stable even if production code
// changes.
const CLASS_ALIASES: Record<string, string[]> = {
  "india pale ale": ["ipa"],
  "double india pale ale": ["dipa", "imperial ipa"],
  "pale ale": ["apa", "american pale ale"],
  lager: ["pilsner", "pils"],
  stout: ["imperial stout"],
  "cabernet sauvignon": ["cab", "cabernet"],
  chardonnay: ["chard"],
  "pinot noir": ["pinot"],
  "sauvignon blanc": ["sauv blanc"],
  whiskey: ["whisky"],
  "bourbon whiskey": ["bourbon"],
  "scotch whisky": ["scotch"],
};

function canonicalClass(s: string): string {
  const n = normalizeText(s);
  for (const [canon, aliases] of Object.entries(CLASS_ALIASES)) {
    if (n === canon || aliases.includes(n)) return canon;
  }
  return n;
}

function compareClassType(expected: string, actual: string): boolean {
  const a = canonicalClass(expected);
  const b = canonicalClass(actual);
  if (a === b) return true;
  return ratio(a, b) >= 0.85;
}

const COUNTRY_ALIASES: Record<string, string[]> = {
  usa: ["united states", "united states of america", "u.s.a.", "u s a", "us"],
  uk: ["united kingdom", "great britain", "england"],
};

function canonicalCountry(s: string): string {
  const n = normalizeText(s);
  for (const [canon, aliases] of Object.entries(COUNTRY_ALIASES)) {
    if (n === canon || aliases.includes(n)) return canon;
  }
  return n;
}

function compareCountry(expected: string, actual: string): boolean {
  return canonicalCountry(expected) === canonicalCountry(actual);
}

// ─── ABV parsing ────────────────────────────────────────────────────────────

function parseAbvPercent(s: string): number | null {
  const m = s.match(/(\d+(?:\.\d+)?)\s*%?/);
  if (!m) return null;
  return parseFloat(m[1]!);
}

// ─── Net contents: parse the ground-truth string + extractor object,
//     normalize both to milliliters, compare within ±1 ml.

const FL_OZ_TO_ML = 29.5735;
const PT_TO_ML = 473.176;

function parseNetContentsToMl(s: string): number | null {
  if (!s) return null;
  // Replace letter-O→0 here so "1 PT O FL OZ" parses as 1 pt 0 fl oz.
  // This is the intentional defect on ai-label-0048; the expected
  // ground truth preserves the "O", so when we parse for ML we treat it
  // as zero.
  const cleaned = s.replace(/(\s|^)O(\s|FL|$)/gi, "$10$2");
  let ml = 0;
  let matched = false;
  const ptMatch = cleaned.match(/(\d+(?:\.\d+)?)\s*PT\b/i);
  if (ptMatch) {
    ml += parseFloat(ptMatch[1]!) * PT_TO_ML;
    matched = true;
  }
  const flozMatch = cleaned.match(/(\d+(?:\.\d+)?)\s*FL\s*OZ\b/i);
  if (flozMatch) {
    ml += parseFloat(flozMatch[1]!) * FL_OZ_TO_ML;
    matched = true;
  }
  const mlMatch = cleaned.match(/(\d+(?:\.\d+)?)\s*mL\b/i);
  if (mlMatch) {
    ml += parseFloat(mlMatch[1]!);
    matched = true;
  }
  const lMatch = cleaned.match(/(\d+(?:\.\d+)?)\s*L\b/);
  if (lMatch && !mlMatch) {
    ml += parseFloat(lMatch[1]!) * 1000;
    matched = true;
  }
  const clMatch = cleaned.match(/(\d+(?:\.\d+)?)\s*cL\b/i);
  if (clMatch) {
    ml += parseFloat(clMatch[1]!) * 10;
    matched = true;
  }
  return matched ? ml : null;
}

function netContentsExtractorToMl(nc: NetContents): number {
  switch (nc.unit) {
    case "ml":
      return nc.value;
    case "L":
      return nc.value * 1000;
    case "cl":
      return nc.value * 10;
    case "fl_oz":
      return nc.value * FL_OZ_TO_ML;
  }
}

// ─── Government warning text comparison against canonical 27 CFR §16.21 ────

function warningTextMatchesRegulation(raw: string | null): boolean {
  if (!raw) return false;
  // Strip the prefix "GOVERNMENT WARNING:" / "GOVERNMENT WARNING" if
  // present so we compare the body. The canonical text matcher is a
  // length-normalized, punctuation-tolerant ratio against the canonical
  // body — high-cost regulation drift (paraphrasing, missing clauses,
  // wrong language) drops the ratio well below 0.95.
  const stripped = raw
    .replace(/^\s*government\s+warning\s*:?\s*/i, "")
    .trim();
  const a = normalizeText(stripped);
  const b = normalizeText(GOVERNMENT_WARNING_BODY);
  return ratio(a, b) >= 0.95;
}

// Also a full-statement comparator (prefix + body) for cases where the
// ground truth carries a deliberate prefix anomaly (missing colon, etc.)
function warningTextMatchesGroundTruth(
  raw: string | null,
  expected: string,
): boolean {
  if (!raw) return false;
  const a = normalizeText(raw);
  const b = normalizeText(expected);
  return ratio(a, b) >= 0.92;
}

// ─── Per-image comparison ───────────────────────────────────────────────────

function compareToGroundTruth(
  gt: GroundTruth,
  extracted: ExtractedFields,
): Diff[] {
  const diffs: Diff[] = [];
  const exp = gt.expectedFields;

  // Brand
  const extBrand = extracted.brand_name.value;
  if (!extBrand) {
    diffs.push({
      field: "brand_name",
      expected: exp.brandName,
      actual: null,
      reason: "Extractor returned null for brand_name.",
    });
  } else {
    const r = fuzzyMatch(exp.brandName, extBrand);
    if (!r.ok) {
      diffs.push({
        field: "brand_name",
        expected: exp.brandName,
        actual: extBrand,
        reason: `Fuzzy mismatch (lev ${r.lev.toFixed(2)}, tok ${r.tok.toFixed(2)}).`,
      });
    }
  }

  // Class / type
  const extClass = extracted.class_type.value;
  if (!extClass) {
    diffs.push({
      field: "class_type",
      expected: exp.classType,
      actual: null,
      reason: "Extractor returned null for class_type.",
    });
  } else if (!compareClassType(exp.classType, extClass)) {
    diffs.push({
      field: "class_type",
      expected: exp.classType,
      actual: extClass,
      reason: "Alias-aware mismatch.",
    });
  }

  // ABV
  const expAbv = parseAbvPercent(exp.alcoholByVolume);
  const extAbv = extracted.abv_percent.value;
  if (expAbv == null) {
    diffs.push({
      field: "abv_percent",
      expected: exp.alcoholByVolume,
      actual: extAbv,
      reason: "Could not parse expected ABV string.",
    });
  } else if (extAbv == null) {
    diffs.push({
      field: "abv_percent",
      expected: expAbv,
      actual: null,
      reason: "Extractor returned null ABV.",
    });
  } else if (Math.abs(extAbv - expAbv) > 0.2) {
    diffs.push({
      field: "abv_percent",
      expected: expAbv,
      actual: extAbv,
      reason: `ABV diff ${Math.abs(extAbv - expAbv).toFixed(2)} pp exceeds ±0.2 pp tolerance.`,
    });
  }

  // Net contents (compare in ml, ±1 ml)
  const expMl = parseNetContentsToMl(exp.netContents);
  const extNc = extracted.net_contents.value;
  if (expMl == null) {
    diffs.push({
      field: "net_contents",
      expected: exp.netContents,
      actual: extNc,
      reason: "Could not parse expected net contents string to ml.",
    });
  } else if (!extNc) {
    diffs.push({
      field: "net_contents",
      expected: exp.netContents,
      actual: null,
      reason: "Extractor returned null net_contents.",
    });
  } else {
    const extMl = netContentsExtractorToMl(extNc);
    if (Math.abs(extMl - expMl) > 1) {
      diffs.push({
        field: "net_contents",
        expected: `${exp.netContents} (${expMl.toFixed(1)} ml)`,
        actual: `${extNc.value} ${extNc.unit} (${extMl.toFixed(1)} ml)`,
        reason: `Net contents differ by ${Math.abs(extMl - expMl).toFixed(2)} ml (tolerance ±1 ml).`,
      });
    }
  }

  // Country of origin. Ground truth countryOfOrigin may itself be null
  // for labels where Codex's audit didn't confirm a visible country (the
  // prompt-intended country was not on the label). In that case, an
  // extractor null is a match; an extractor value is "extractor saw
  // something Codex missed" (flag it).
  const extCountry = extracted.country_of_origin.value;
  if (exp.countryOfOrigin === null) {
    if (extCountry) {
      diffs.push({
        field: "country_of_origin",
        expected: null,
        actual: extCountry,
        reason:
          "Ground truth says no country visible; extractor read one — Codex may have missed it.",
      });
    }
  } else if (!extCountry) {
    diffs.push({
      field: "country_of_origin",
      expected: exp.countryOfOrigin,
      actual: null,
      reason: "Extractor returned null country_of_origin.",
    });
  } else if (!compareCountry(exp.countryOfOrigin, extCountry)) {
    diffs.push({
      field: "country_of_origin",
      expected: exp.countryOfOrigin,
      actual: extCountry,
      reason: "Alias-aware country mismatch.",
    });
  }

  // Government warning — presence
  const expHasWarning = exp.governmentWarning !== null;
  const extWarningRaw = extracted.government_warning.value?.raw_text ?? null;
  const extHasWarning = !!extWarningRaw && extWarningRaw.trim().length > 0;
  if (expHasWarning !== extHasWarning) {
    diffs.push({
      field: "government_warning.present",
      expected: expHasWarning,
      actual: extHasWarning,
      reason: expHasWarning
        ? "Ground truth says warning is present; extractor did not see one."
        : "Ground truth says warning is absent; extractor reported one.",
    });
  }

  // Government warning — text matches regulation
  // Compare ONLY when ground truth has a warning. If ground truth's
  // warning is the canonical compliant text, expected = canonical match.
  // If ground truth's warning is intentionally non-compliant (T1/T2/X4/X5
  // etc.), the comparison runs against the ground-truth string itself
  // and matches_regulation may legitimately be false on both sides.
  if (expHasWarning && extHasWarning) {
    const canonical = canonicalStatement();
    const expMatchesCanon =
      ratio(normalizeText(exp.governmentWarning!), normalizeText(canonical)) >=
      0.95;
    const extMatchesCanon = warningTextMatchesRegulation(extWarningRaw);
    if (expMatchesCanon !== extMatchesCanon) {
      diffs.push({
        field: "government_warning.text_matches_regulation",
        expected: expMatchesCanon,
        actual: extMatchesCanon,
        reason: `Canonical-warning agreement disagrees (expected ${expMatchesCanon}, extracted ${extMatchesCanon}).`,
      });
    }
    // Direct text drift vs ground truth string (looser threshold so we
    // tolerate the deliberate prefix/punctuation anomalies the corpus
    // encodes — but still catch substantive paraphrasing).
    if (!warningTextMatchesGroundTruth(extWarningRaw, exp.governmentWarning!)) {
      diffs.push({
        field: "government_warning.raw_text",
        expected: exp.governmentWarning,
        actual: extWarningRaw,
        reason: "Raw warning text drifts >8% from ground-truth string.",
      });
    }
  }

  // Producer name
  const extProducer = extracted.producer.value?.name ?? null;
  // Ground truth carries a freeform "producerAddress" line. Compare the
  // extractor's producer.name (or the first comma-delimited chunk of
  // producerAddress) — fuzzy match suffices.
  const expProducerName = exp.producerAddress.split(",")[0]!.trim();
  if (!extProducer) {
    diffs.push({
      field: "producer.name",
      expected: expProducerName,
      actual: null,
      reason: "Extractor returned null producer.name.",
    });
  } else {
    const r = fuzzyMatch(expProducerName, extProducer);
    if (!r.ok) {
      diffs.push({
        field: "producer.name",
        expected: expProducerName,
        actual: extProducer,
        reason: `Fuzzy mismatch (lev ${r.lev.toFixed(2)}, tok ${r.tok.toFixed(2)}).`,
      });
    }
  }

  return diffs;
}

// ─── Argv ───────────────────────────────────────────────────────────────────

function parseArgs(argv: string[]): { limit: number | null; id: string | null } {
  let limit: number | null = null;
  let id: string | null = null;
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === "--limit") {
      limit = parseInt(argv[i + 1] ?? "", 10);
      i++;
    } else if (argv[i] === "--id") {
      id = argv[i + 1] ?? null;
      i++;
    }
  }
  return { limit, id };
}

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

// ─── Main ───────────────────────────────────────────────────────────────────

async function main(): Promise<void> {
  const root = process.cwd();
  loadDotenv(join(root, ".env.local"));

  const apiKey = process.env.GOOGLE_API_KEY;
  if (!apiKey) {
    console.error(
      "[cross-validate] GOOGLE_API_KEY not set; cannot run oracle pass.",
    );
    process.exit(1);
  }

  const { limit, id } = parseArgs(process.argv.slice(2));

  const truthDir = join(root, "test-data/ai-generated/ground-truth");
  const imagesDir = join(root, "test-data/ai-generated/labels");
  const reportDir = join(root, ".review");
  if (!existsSync(reportDir)) await mkdir(reportDir, { recursive: true });

  const files = (await readdir(truthDir))
    .filter((f) => f.endsWith(".json"))
    .sort();
  const targets = id
    ? files.filter((f) => f === `${id}.json`)
    : limit
      ? files.slice(0, limit)
      : files;

  console.log(
    `[cross-validate] using gemini-3.1-pro-preview; ${targets.length} image(s) to validate`,
  );

  const extractor = new GeminiProExtractor({ apiKey });
  const reports: ImageReport[] = [];
  let totalCost = 0;
  let totalInputTokens = 0;
  let totalOutputTokens = 0;
  const tStart = performance.now();

  for (let i = 0; i < targets.length; i++) {
    const file = targets[i]!;
    const gtPath = join(truthDir, file);
    const gt = JSON.parse(await readFile(gtPath, "utf8")) as GroundTruth;
    const imgPath = join(root, "test-data/ai-generated", gt.image);

    const tImg = performance.now();
    process.stdout.write(`[${i + 1}/${targets.length}] ${gt.id} ... `);

    try {
      const raw = await readFile(imgPath);
      const pre = await preprocessImage(raw);
      const ctrl = new AbortController();
      const timer = setTimeout(() => ctrl.abort(), 30_000);
      let result;
      try {
        result = await extractor.extract(pre.buffer, { signal: ctrl.signal });
      } finally {
        clearTimeout(timer);
      }

      const diffs = compareToGroundTruth(gt, result.fields);
      const status: Status = diffs.length === 0 ? "match" : "drift";
      totalCost += result.cost.costUsd;
      totalInputTokens += result.cost.inputTokens;
      totalOutputTokens += result.cost.outputTokens;
      reports.push({
        id: gt.id,
        status,
        usageTier: gt.visualAudit?.usageTier,
        diffs,
        extractorRaw: result.fields,
        latencyMs: result.latencyMs,
        costUsd: result.cost.costUsd,
        inputTokens: result.cost.inputTokens,
        outputTokens: result.cost.outputTokens,
      });

      if (status === "match") {
        console.log(
          `OK (${((performance.now() - tImg) / 1000).toFixed(1)}s, $${result.cost.costUsd.toFixed(4)})`,
        );
      } else {
        console.log(
          `DRIFT × ${diffs.length} (${((performance.now() - tImg) / 1000).toFixed(1)}s, $${result.cost.costUsd.toFixed(4)})`,
        );
        for (const d of diffs) {
          // Truncate long values like full warning text in console output
          const trunc = (v: unknown): string => {
            const s = typeof v === "string" ? v : JSON.stringify(v);
            return s.length > 80 ? s.slice(0, 77) + "..." : s;
          };
          console.log(
            `    DRIFT ${gt.id}: ${d.field} expected "${trunc(d.expected)}" got "${trunc(d.actual)}"`,
          );
        }
      }
    } catch (err) {
      const msg = (err as Error).message ?? String(err);
      console.log(`ERROR (${msg.slice(0, 120)})`);
      reports.push({
        id: gt.id,
        status: "error",
        usageTier: gt.visualAudit?.usageTier,
        diffs: [],
        extractorRaw: null,
        extractorError: msg,
      });
    }

    // ~1 RPS throttle; the call itself takes several seconds so this is
    // a floor, not a ceiling.
    if (i < targets.length - 1) await sleep(1000);
  }

  const elapsedMs = performance.now() - tStart;
  const matches = reports.filter((r) => r.status === "match").length;
  const drifts = reports.filter((r) => r.status === "drift").length;
  const errors = reports.filter((r) => r.status === "error").length;

  // Per-field drift counts
  const fieldDrift: Record<string, number> = {};
  for (const r of reports) {
    for (const d of r.diffs) {
      fieldDrift[d.field] = (fieldDrift[d.field] ?? 0) + 1;
    }
  }
  const fieldDriftSorted = Object.entries(fieldDrift).sort(
    (a, b) => b[1] - a[1],
  );

  // ─── Markdown report ──────────────────────────────────────────────────────
  const md: string[] = [];
  md.push("# AI Corpus Cross-Validation Report");
  md.push("");
  md.push(
    `Oracle: \`gemini-3.1-pro-preview\` via \`GeminiProExtractor\`. Each image preprocessed via \`preprocessImage()\` (sharp).`,
  );
  md.push(`Run at: ${new Date().toISOString()}`);
  md.push(
    `Wall-clock: ${(elapsedMs / 1000).toFixed(1)}s (${(elapsedMs / 60_000).toFixed(2)} min)`,
  );
  md.push("");
  md.push("## Summary");
  md.push("");
  md.push(`- Images validated: **${reports.length}**`);
  md.push(
    `- Strict matches: **${matches}** (${((matches / reports.length) * 100).toFixed(1)}%)`,
  );
  md.push(`- Drift: **${drifts}**`);
  md.push(`- Errors: **${errors}**`);
  md.push(
    `- Tokens: ${totalInputTokens.toLocaleString()} in / ${totalOutputTokens.toLocaleString()} out`,
  );
  md.push(`- Total cost: **$${totalCost.toFixed(4)}**`);
  md.push("");
  md.push("## Per-field drift counts");
  md.push("");
  if (fieldDriftSorted.length === 0) {
    md.push("_No drift across any field — full corpus agreement._");
  } else {
    md.push("| Field | Drift count |");
    md.push("| --- | ---: |");
    for (const [f, n] of fieldDriftSorted) md.push(`| \`${f}\` | ${n} |`);
  }
  md.push("");
  md.push("## Per-image drift");
  md.push("");
  md.push("| ID | Usage tier | Status | Drifted fields |");
  md.push("| --- | --- | --- | --- |");
  for (const r of reports) {
    const fields =
      r.status === "drift"
        ? r.diffs.map((d) => `\`${d.field}\``).join(", ")
        : r.status === "error"
          ? `_error: ${r.extractorError?.slice(0, 80) ?? "unknown"}_`
          : "—";
    md.push(
      `| ${r.id} | ${r.usageTier ?? "n/a"} | ${r.status.toUpperCase()} | ${fields} |`,
    );
  }
  md.push("");
  md.push("## Drift detail (per-image diffs)");
  md.push("");
  const driftReports = reports.filter((r) => r.status === "drift");
  if (driftReports.length === 0) {
    md.push("_No drift._");
  } else {
    for (const r of driftReports) {
      md.push(`### ${r.id}`);
      md.push("");
      for (const d of r.diffs) {
        const fmt = (v: unknown): string => {
          if (v === null || v === undefined) return "null";
          if (typeof v === "string")
            return v.length > 200 ? v.slice(0, 197) + "..." : v;
          return JSON.stringify(v).slice(0, 200);
        };
        md.push(
          `- **${d.field}** — expected \`${fmt(d.expected)}\`, got \`${fmt(d.actual)}\`. ${d.reason}`,
        );
      }
      md.push("");
    }
  }
  md.push("");
  md.push("## Commentary");
  md.push("");
  const strictReady = reports.filter(
    (r) => r.usageTier === "strictBenchmarkReady",
  );
  const strictReadyMatch = strictReady.filter(
    (r) => r.status === "match",
  ).length;
  const robustnessOnly = reports.filter((r) => r.usageTier === "robustnessOnly");
  const robustnessMatch = robustnessOnly.filter(
    (r) => r.status === "match",
  ).length;
  md.push(
    `- Of the ${strictReady.length} \`strictBenchmarkReady\` images, ${strictReadyMatch} fully agree with the oracle.`,
  );
  md.push(
    `- Of the ${robustnessOnly.length} \`robustnessOnly\` images, ${robustnessMatch} fully agree (drift here is expected; these are kept for OCR/vision stress, not strict ground truth).`,
  );
  md.push("");
  md.push("## Costing");
  md.push("");
  md.push(
    "Pricing reference: Gemini Pro tier (<200K context) per `src/lib/vision/gemini.ts` = $1.25 / 1M input + $5.00 / 1M output tokens.",
  );
  md.push(
    `Computed at the per-image level using the SDK's reported \`usageMetadata\`, summed: **$${totalCost.toFixed(4)}**.`,
  );
  md.push("");

  await writeFile(
    join(reportDir, "ai-corpus-cross-validation.md"),
    md.join("\n"),
    "utf8",
  );

  // ─── JSON report (machine-readable) ──────────────────────────────────────
  const json = {
    runAt: new Date().toISOString(),
    extractor: extractor.id,
    modelVersion: extractor.modelVersion,
    totals: {
      validated: reports.length,
      match: matches,
      drift: drifts,
      error: errors,
      inputTokens: totalInputTokens,
      outputTokens: totalOutputTokens,
      costUsd: totalCost,
      wallClockMs: elapsedMs,
    },
    fieldDrift,
    reports,
  };
  await writeFile(
    join(reportDir, "ai-corpus-cross-validation.json"),
    JSON.stringify(json, null, 2),
    "utf8",
  );

  console.log(
    `\n[cross-validate] done. match=${matches} drift=${drifts} error=${errors}. cost=$${totalCost.toFixed(4)}. wallclock=${(elapsedMs / 1000).toFixed(1)}s`,
  );
  console.log(`[cross-validate] wrote .review/ai-corpus-cross-validation.md`);
  console.log(`[cross-validate] wrote .review/ai-corpus-cross-validation.json`);
}

main().catch((err: unknown) => {
  console.error("[cross-validate] fatal:", err);
  process.exit(1);
});
