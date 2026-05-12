// LabelVerify v2 corpus generator.
//
// Parallel effort to scripts/generate-corpus.ts. Outputs to a separate
// directory (default test-data-v2/) so the two corpora can be compared.
//
// What v2 changes vs v1:
//   - Five visual ARCHETYPES per beverage type (modern-minimal, vintage,
//     craft, premium-dark, bold-display) instead of one shared template
//     style — more visual diversity for the extractor benchmark.
//   - SVG decoration library: ornamental frames, ribbons, monograms,
//     beverage-type-specific illustration motifs (hops, grapes, barrel,
//     copper still silhouettes, sun motifs).
//   - Mixed typography: serif heads + sans body, with archetype-specific
//     font stacks (Didone-ish, slab serif, script-accent, etc).
//   - Defects from v1 fixed: T6 uses real smart-quote contamination,
//     S1/S2/S3 mutations are visibly rendered, X2 places the warning on
//     a narrow vertical strip at the edge so it is genuinely hard to
//     read, B3 medium-weight is clearly differentiated.
//   - Curved-bow degradation: amplified factor + SVG warp simulation so
//     curvature is visible at every requested bow level.
//
// CLI:
//   npx tsx scripts/generate-corpus-v2.ts [--seed N] [--count 60]
//      [--degrade 30] [--output test-data-v2]

import { mkdir, rm, writeFile } from "node:fs/promises";
import { join, relative } from "node:path";
import sharp from "sharp";

// ─── canvas / regulation constants ──────────────────────────────────────────

const CANVAS = { width: 900, height: 1200 };
const DEFAULT_SEED = 4242;
const DEFAULT_SYNTHETIC_COUNT = 60;
const DEFAULT_DEGRADED_COUNT = 30;
const DEFAULT_OUTPUT = "test-data-v2";

const GOVERNMENT_WARNING_PREFIX = "GOVERNMENT WARNING:";
const GOVERNMENT_WARNING_BODY =
  "(1) According to the Surgeon General, women should not drink alcoholic beverages during pregnancy because of the risk of birth defects. (2) Consumption of alcoholic beverages impairs your ability to drive a car or operate machinery, and may cause health problems.";

// ─── types (mirror v1 + add Archetype) ──────────────────────────────────────

type Source = "synthetic" | "degraded" | "real";
type BeverageType = "beer" | "wine" | "spirits" | "fortified_wine" | "rtd";
type ClassCategory = "beer" | "wine" | "distilled_spirits" | "fortified_wine";
type LabelFace = "front" | "back" | "neck";
type NetUnit = "fl_oz" | "ml" | "L" | "cl";
type BrandPattern = "single" | "multi" | "punctuation" | "stylized";
type Archetype =
  | "modern-minimal"
  | "vintage-classical"
  | "craft-artisanal"
  | "premium-dark"
  | "bold-display";

interface NetContents {
  value: number;
  unit: NetUnit;
}
interface ProducerAddress {
  name: string | null;
  street: string | null;
  city: string | null;
  state: string | null;
  postal_code: string | null;
  country: string | null;
}
interface GovernmentWarningTruth {
  present: boolean;
  text_matches_regulation: boolean;
  prefix_all_caps: boolean;
  prefix_bold: boolean;
  meets_size_minimum: boolean;
}
interface GroundTruth {
  id: string;
  source: Source;
  image: string;
  degradations: string[];
  beverage_type: BeverageType;
  label_face: LabelFace;
  container_size_ml: number;
  fields: {
    brand_name: string;
    class_type: string;
    class_category: ClassCategory;
    abv_percent: number;
    net_contents: NetContents;
    producer: ProducerAddress;
    country_of_origin: string;
    government_warning: GovernmentWarningTruth;
  };
  gov_warning_case: string | null;
  notes: string;
}

interface RenderedWarning {
  visible: boolean;
  prefixText: string;
  bodyText: string;
  prefixWeight: number; // 400 regular, 500 medium, 700 bold
  bodyWeight: number;
  prefixFontSize: number;
  bodyFontSize: number;
  textured: boolean;
  crowded: boolean;
  edgeStrip: boolean; // X2: render on extreme narrow vertical strip
  foreignOnly: boolean; // X3
}

interface Palette {
  background: string;
  panel: string;
  ink: string;
  muted: string;
  accent: string;
  accent2: string;
  warningBg: string;
  border: string;
  /** Optional darker variant for premium-dark archetype. */
  dark?: string;
  /** Decorative metallic-look color (gold/copper). */
  metallic?: string;
}

interface SyntheticSpec {
  truth: GroundTruth;
  warning: RenderedWarning;
  palette: Palette;
  brandPattern: BrandPattern;
  archetype: Archetype;
}

interface Args {
  seed: number;
  count: number;
  degrade: number;
  output: string;
}

// ─── seeded PRNG (Mulberry32) ───────────────────────────────────────────────

function makeRng(seed: number): () => number {
  let s = seed >>> 0;
  return () => {
    s = (s + 0x6d2b79f5) >>> 0;
    let t = s;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}
function pick<T>(rng: () => number, arr: readonly T[]): T {
  return arr[Math.floor(rng() * arr.length)]!;
}
function pickN<T>(rng: () => number, arr: readonly T[], n: number): T[] {
  const copy = arr.slice();
  const out: T[] = [];
  for (let i = 0; i < n && copy.length; i++) {
    const idx = Math.floor(rng() * copy.length);
    out.push(copy.splice(idx, 1)[0]!);
  }
  return out;
}
function rngRange(rng: () => number, lo: number, hi: number): number {
  return lo + rng() * (hi - lo);
}
function rngInt(rng: () => number, lo: number, hi: number): number {
  return Math.floor(rngRange(rng, lo, hi + 1));
}

// ─── palettes (extended) ────────────────────────────────────────────────────

const PALETTES: Palette[] = [
  {
    background: "#fdfaf3",
    panel: "#fdfaf3",
    ink: "#1a1f2c",
    muted: "#566273",
    accent: "#1d4ed8",
    accent2: "#b45309",
    warningBg: "#fffdf6",
    border: "#1d3557",
    metallic: "#b08b3a",
  },
  {
    background: "#0f1c2e",
    panel: "#13243b",
    ink: "#f4ebd6",
    muted: "#b8a878",
    accent: "#c4923c",
    accent2: "#7f1d1d",
    warningBg: "#1a2c47",
    border: "#c4923c",
    dark: "#0a1424",
    metallic: "#d6b56b",
  },
  {
    background: "#efe7d4",
    panel: "#f7f1de",
    ink: "#2c1d0d",
    muted: "#6d5a3e",
    accent: "#7c2d12",
    accent2: "#3f6212",
    warningBg: "#fbf6e9",
    border: "#5a3a1a",
    metallic: "#9a6f29",
  },
  {
    background: "#fff8f0",
    panel: "#fff3e7",
    ink: "#1b1b1f",
    muted: "#5a4630",
    accent: "#a13c00",
    accent2: "#34495e",
    warningBg: "#fffaf0",
    border: "#3f2718",
  },
  {
    background: "#0a1612",
    panel: "#10221b",
    ink: "#e7e9e4",
    muted: "#a5b9ad",
    accent: "#6ee7b7",
    accent2: "#fcd34d",
    warningBg: "#142e25",
    border: "#1a3d31",
    dark: "#050d0a",
  },
  {
    background: "#f3eee3",
    panel: "#faf6ec",
    ink: "#1e1b16",
    muted: "#665b48",
    accent: "#7c2d12",
    accent2: "#b45309",
    warningBg: "#fffaf0",
    border: "#3a2916",
    metallic: "#a07621",
  },
  {
    background: "#ebf0ed",
    panel: "#f7f9f5",
    ink: "#0f221c",
    muted: "#3f5a4e",
    accent: "#0f5132",
    accent2: "#0c4a6e",
    warningBg: "#f0f7f3",
    border: "#0f3d2a",
  },
];

// ─── faux brand wordlist ────────────────────────────────────────────────────

const BRANDS: Record<BeverageType, Record<BrandPattern, string[]>> = {
  beer: {
    single: ["Bluerose", "Headlands", "Sundial", "Cairnmark", "Fieldstone", "Wayfarer", "Otterbay"],
    multi: ["Mill Creek", "Tin Roof", "Cold Iron", "Old Cypress", "Latitude Seven", "Wandering Coyote"],
    punctuation: ["Stone's Throw", "O'Reilly Hollow", "Field & Bramble", "Rust & Ember", "Half-Note"],
    stylized: ["STONE'S THROW", "TIN ROOF", "COLD IRON", "OLD CYPRESS", "LATITUDE 7", "RUST & EMBER"],
  },
  wine: {
    single: ["Vespera", "Argenton", "Halfwild", "Saltwood", "Bertelli", "Mirelle"],
    multi: ["Marbled Hills", "Mira Vista", "Calder Estates", "Solano Reach", "Old Schoolhouse"],
    punctuation: ["Roan & Stone", "Five Sisters", "Mt. Frieda Cellars", "Cote du Soir", "Castelo do Vento"],
    stylized: ["VESPERA", "MARBLED HILLS", "MIRA VISTA", "CALDER ESTATES", "SOLANO REACH"],
  },
  spirits: {
    single: ["Saltgrass", "Northmast", "Longwhistle", "Vidalia", "Cloister", "Ironweed"],
    multi: ["Six Foxes", "Cloister Hill", "Vagrant Tide", "Black Cardamom", "Iron Magnolia"],
    punctuation: ["Ashby & Drake", "Marrow & Bone", "Mercer's Reserve", "Tarn & Heath", "Fox's Lantern"],
    stylized: ["SIX FOXES", "CLOISTER HILL", "BLACK CARDAMOM", "IRON MAGNOLIA", "SALTGRASS"],
  },
  fortified_wine: {
    single: ["Solstice", "Sunbeam", "Marin", "Madrona", "Vermella"],
    multi: ["Solstice Vermouth", "Cave Marin", "Sunbeam Spritz", "Harbor Madeira"],
    punctuation: ["Hibiscus + Salt", "Madrona Port", "Cave & Coast", "Solstice No. 7"],
    stylized: ["SOLSTICE VERMOUTH", "CAVE MARIN", "MADRONA PORT", "HIBISCUS + SALT"],
  },
  rtd: {
    single: ["Briskly", "Hearth", "Beryl", "Palisade"],
    multi: ["Garden Highball", "Citrus Range", "Harbor Fizz"],
    punctuation: ["Lemon & Bay", "Juniper No. 3", "Citrus & Rye", "Rose + Tonic"],
    stylized: ["HARBOR FIZZ", "CITRUS RANGE", "GARDEN HIGHBALL"],
  },
};

const CLASS_TYPES: Record<BeverageType, string[]> = {
  beer: ["India Pale Ale", "Pale Ale", "Stout", "Pilsner", "Lager", "Hazy IPA", "Saison", "Porter", "Wheat Beer", "Amber Ale"],
  wine: ["Cabernet Sauvignon", "Chardonnay", "Pinot Noir", "Sauvignon Blanc", "Merlot", "Syrah", "Rose", "Riesling", "Zinfandel", "Sparkling Wine"],
  spirits: ["Bourbon Whiskey", "Rye Whiskey", "Scotch Whisky", "Vodka", "London Dry Gin", "Aged Rum", "Tequila Blanco", "Reposado Tequila", "Mezcal"],
  fortified_wine: ["Ruby Port", "Tawny Port", "Sherry", "Vermouth", "Madeira"],
  rtd: ["Canned Cocktail", "Vodka Soda", "Malt Beverage", "Wine Cocktail", "Hard Seltzer"],
};

const ADDRESSES: Array<[string, string, string, string]> = [
  ["14 Mill St", "Asheville", "NC", "28801"],
  ["802 Harbor Way", "Portland", "ME", "04101"],
  ["2210 West 6th Ave", "Denver", "CO", "80204"],
  ["77 Market Plaza", "Santa Rosa", "CA", "95401"],
  ["310 River Rd", "Lexington", "KY", "40508"],
  ["945 Main St", "Walla Walla", "WA", "99362"],
  ["1190 Mission Ave", "San Antonio", "TX", "78210"],
  ["32 Orchard Ln", "Traverse City", "MI", "49684"],
  ["5400 Bayou Dr", "New Orleans", "LA", "70117"],
  ["65 Copper Hill Rd", "Burlington", "VT", "05401"],
  ["188 Quarry Pass", "Boise", "ID", "83702"],
  ["7 Forge Alley", "Charleston", "SC", "29401"],
];

// ─── gov-warning case distribution ──────────────────────────────────────────

// 60 synthetic labels, target split: 20 compliant + 30 non-compliant +
// 10 missing. After the degraded run (which adds 10 X1 + 10 mutations +
// 10 compliant), total settles at 30/40/20 across 90.
const SYN_CASE_PLAN: Array<string | null> = [
  // 20 compliant
  ...Array(20).fill(null),
  // 30 non-compliant — every taxonomy axis represented
  "T1", "T1", "T1", "T2", "T2", "T2",
  "T3", "T3", "T4", "T4",
  "T5", "T5", "T6", "T6", // smart-quote contamination, fixed
  "C1", "C1", "C2", "C2", "C3", "C3",
  "B1", "B2", "B3", "B4",
  "S1", "S2", "S3",
  "X2", "X3", "T1/B2", // X2 placed on edge strip; X3 Spanish-only; mixed
  // 10 missing
  ...Array(10).fill("X1"),
];

// ─── SVG illustration motifs ────────────────────────────────────────────────

function svgHopMotif(x: number, y: number, color: string, scale = 1): string {
  // Stylized hop cone
  const s = scale;
  return `<g transform="translate(${x},${y}) scale(${s})" opacity="0.85">
    <ellipse cx="0" cy="0" rx="22" ry="34" fill="${color}"/>
    <path d="M0,-32 Q14,-18 10,-2 Q22,-12 18,8 Q26,0 22,18 Q14,12 10,26 Q4,18 0,32 Q-4,18 -10,26 Q-14,12 -22,18 Q-26,0 -18,8 Q-22,-12 -10,-2 Q-14,-18 0,-32 Z"
      fill="${color}" stroke="${color}" stroke-width="0.5" opacity="0.95"/>
    <line x1="0" y1="-34" x2="0" y2="-46" stroke="${color}" stroke-width="2"/>
  </g>`;
}

function svgGrapeMotif(x: number, y: number, color: string, leaf: string, scale = 1): string {
  const s = scale;
  const circles: string[] = [];
  const rows = [
    [-18, 0],
    [-9, 9, -27, 9],
    [0, 18, -18, 18, -36, 18, -27, 27, -9, 27],
    [-18, 36, -9, 45],
    [-18, 54],
  ];
  for (const row of rows) {
    for (let i = 0; i < row.length; i += 2) {
      circles.push(`<circle cx="${row[i]}" cy="${row[i + 1]}" r="9" fill="${color}"/>`);
    }
  }
  return `<g transform="translate(${x},${y}) scale(${s})">
    ${circles.join("")}
    <path d="M-10,-10 Q-30,-30 -10,-30 Q0,-25 -10,-10 Z" fill="${leaf}"/>
    <path d="M-10,-10 Q10,-30 20,-15 Q5,-12 -10,-10 Z" fill="${leaf}"/>
  </g>`;
}

function svgBarrelMotif(x: number, y: number, color: string, band: string, scale = 1): string {
  const s = scale;
  return `<g transform="translate(${x},${y}) scale(${s})">
    <ellipse cx="0" cy="-40" rx="34" ry="6" fill="${color}" stroke="${band}" stroke-width="1"/>
    <path d="M-34,-40 Q-44,0 -34,40 L34,40 Q44,0 34,-40 Z" fill="${color}"/>
    <rect x="-44" y="-12" width="88" height="6" fill="${band}"/>
    <rect x="-44" y="6" width="88" height="6" fill="${band}"/>
    <rect x="-44" y="-28" width="88" height="4" fill="${band}" opacity="0.6"/>
    <rect x="-44" y="22" width="88" height="4" fill="${band}" opacity="0.6"/>
  </g>`;
}

function svgStillMotif(x: number, y: number, color: string, scale = 1): string {
  const s = scale;
  return `<g transform="translate(${x},${y}) scale(${s})">
    <circle cx="0" cy="0" r="32" fill="${color}"/>
    <path d="M-18,-28 Q0,-48 18,-28 L18,-10 Q0,-20 -18,-10 Z" fill="${color}"/>
    <rect x="-4" y="-46" width="8" height="18" fill="${color}"/>
    <path d="M16,8 Q42,12 38,42" stroke="${color}" stroke-width="6" fill="none" stroke-linecap="round"/>
  </g>`;
}

function svgSunMotif(x: number, y: number, color: string, scale = 1): string {
  const s = scale;
  const rays: string[] = [];
  for (let i = 0; i < 12; i++) {
    const a = (i / 12) * Math.PI * 2;
    const x1 = Math.cos(a) * 28;
    const y1 = Math.sin(a) * 28;
    const x2 = Math.cos(a) * 44;
    const y2 = Math.sin(a) * 44;
    rays.push(`<line x1="${x1.toFixed(1)}" y1="${y1.toFixed(1)}" x2="${x2.toFixed(1)}" y2="${y2.toFixed(1)}" stroke="${color}" stroke-width="3" stroke-linecap="round"/>`);
  }
  return `<g transform="translate(${x},${y}) scale(${s})">
    <circle cx="0" cy="0" r="20" fill="${color}"/>
    ${rays.join("")}
  </g>`;
}

function svgWheatMotif(x: number, y: number, color: string, scale = 1): string {
  const s = scale;
  const grains: string[] = [];
  for (let i = -6; i <= 6; i += 1) {
    const yy = i * 4;
    grains.push(`<ellipse cx="-6" cy="${yy}" rx="3" ry="5" fill="${color}" transform="rotate(-30 -6 ${yy})"/>`);
    grains.push(`<ellipse cx="6"  cy="${yy}" rx="3" ry="5" fill="${color}" transform="rotate(30 6 ${yy})"/>`);
  }
  return `<g transform="translate(${x},${y}) scale(${s})">
    <line x1="0" y1="-30" x2="0" y2="40" stroke="${color}" stroke-width="2"/>
    ${grains.join("")}
  </g>`;
}

function svgMountainMotif(x: number, y: number, color: string, scale = 1): string {
  const s = scale;
  return `<g transform="translate(${x},${y}) scale(${s})">
    <path d="M-50,30 L-15,-30 L0,0 L20,-40 L55,30 Z" fill="${color}"/>
    <path d="M-15,-30 L-9,-22 L-12,-18 Z" fill="#ffffff" opacity="0.65"/>
    <path d="M20,-40 L26,-30 L23,-26 Z" fill="#ffffff" opacity="0.65"/>
  </g>`;
}

function motifFor(beverage: BeverageType, color: string, accent: string, scale: number, x: number, y: number): string {
  switch (beverage) {
    case "beer":
      return svgHopMotif(x, y, color, scale) + svgWheatMotif(x - 50, y + 10, accent, scale * 0.8);
    case "wine":
      return svgGrapeMotif(x, y, color, accent, scale);
    case "spirits":
      return svgBarrelMotif(x, y, color, accent, scale) + svgStillMotif(x + 60, y + 20, accent, scale * 0.6);
    case "fortified_wine":
      return svgSunMotif(x, y, color, scale);
    case "rtd":
      return svgSunMotif(x, y, accent, scale * 0.8);
  }
}

// ─── ornamental frame helpers ───────────────────────────────────────────────

function ornateFrame(stroke: string, accent: string): string {
  // Triple-line border with corner ornaments — vintage feel.
  return `
    <rect x="24" y="24" width="${CANVAS.width - 48}" height="${CANVAS.height - 48}" rx="14" fill="none" stroke="${stroke}" stroke-width="3"/>
    <rect x="40" y="40" width="${CANVAS.width - 80}" height="${CANVAS.height - 80}" rx="8"  fill="none" stroke="${stroke}" stroke-width="1.4"/>
    <rect x="52" y="52" width="${CANVAS.width - 104}" height="${CANVAS.height - 104}" rx="4" fill="none" stroke="${stroke}" stroke-width="0.8" opacity="0.5"/>
    ${cornerOrnament(40, 40, accent, "tl")}
    ${cornerOrnament(CANVAS.width - 40, 40, accent, "tr")}
    ${cornerOrnament(40, CANVAS.height - 40, accent, "bl")}
    ${cornerOrnament(CANVAS.width - 40, CANVAS.height - 40, accent, "br")}
  `;
}
function cornerOrnament(x: number, y: number, fill: string, corner: "tl" | "tr" | "bl" | "br"): string {
  const rot = corner === "tr" ? 90 : corner === "br" ? 180 : corner === "bl" ? 270 : 0;
  return `<g transform="translate(${x},${y}) rotate(${rot})" opacity="0.85">
    <path d="M0,0 L34,0 L30,4 L4,4 L4,30 L0,34 Z" fill="${fill}"/>
    <circle cx="22" cy="22" r="3.5" fill="${fill}"/>
  </g>`;
}

function geometricFrame(stroke: string): string {
  // Hairline frame with mid-edge marks — modern minimal.
  const w = CANVAS.width, h = CANVAS.height;
  return `
    <rect x="28" y="28" width="${w - 56}" height="${h - 56}" fill="none" stroke="${stroke}" stroke-width="1.2"/>
    <line x1="${w / 2 - 26}" y1="28" x2="${w / 2 + 26}" y2="28" stroke="${stroke}" stroke-width="3"/>
    <line x1="${w / 2 - 26}" y1="${h - 28}" x2="${w / 2 + 26}" y2="${h - 28}" stroke="${stroke}" stroke-width="3"/>
  `;
}

function bandedFrame(stroke: string, accent: string): string {
  // Two coloured bands on top + bottom — bold display.
  const w = CANVAS.width, h = CANVAS.height;
  return `
    <rect x="0" y="0" width="${w}" height="60" fill="${accent}"/>
    <rect x="0" y="${h - 60}" width="${w}" height="60" fill="${accent}"/>
    <rect x="0" y="60" width="${w}" height="6" fill="${stroke}"/>
    <rect x="0" y="${h - 66}" width="${w}" height="6" fill="${stroke}"/>
  `;
}

function craftFrame(stroke: string, accent: string): string {
  // Rough hand-drawn rectangle with scribbled corners
  return `
    <rect x="36" y="36" width="${CANVAS.width - 72}" height="${CANVAS.height - 72}" fill="none" stroke="${stroke}" stroke-width="2.2" stroke-dasharray="14 4 2 4"/>
    <rect x="50" y="50" width="${CANVAS.width - 100}" height="${CANVAS.height - 100}" fill="none" stroke="${accent}" stroke-width="0.8" opacity="0.55"/>
  `;
}

function premiumFrame(stroke: string, metallic: string): string {
  // Thin gilded inner frame
  return `
    <rect x="40" y="40" width="${CANVAS.width - 80}" height="${CANVAS.height - 80}" fill="none" stroke="${metallic}" stroke-width="1.4"/>
    <rect x="56" y="56" width="${CANVAS.width - 112}" height="${CANVAS.height - 112}" fill="none" stroke="${stroke}" stroke-width="0.6" opacity="0.4"/>
    ${cornerOrnament(56, 56, metallic, "tl")}
    ${cornerOrnament(CANVAS.width - 56, 56, metallic, "tr")}
    ${cornerOrnament(56, CANVAS.height - 56, metallic, "bl")}
    ${cornerOrnament(CANVAS.width - 56, CANVAS.height - 56, metallic, "br")}
  `;
}

// ─── typography helpers ─────────────────────────────────────────────────────

const FONT_STACKS = {
  // SVG renders these in the order specified; sharp on Vercel falls back
  // to platform defaults if specific faces are unavailable. The result is
  // visually varied across machines but always legible.
  serifDisplay: '"Playfair Display", "Didot", "Bodoni 72", "Times New Roman", serif',
  slab: '"Roboto Slab", "Rockwell", Georgia, serif',
  sans: '"Inter", "Helvetica Neue", Arial, sans-serif',
  condensed: '"Oswald", "Impact", "Arial Narrow", sans-serif',
  script: '"Allura", "Pacifico", "Lucida Handwriting", cursive',
  mono: '"IBM Plex Mono", "Menlo", Consolas, monospace',
};

// ─── XML escape ─────────────────────────────────────────────────────────────

function esc(s: string): string {
  return s.replace(/[&<>'"]/g, (c) => {
    if (c === "&") return "&amp;";
    if (c === "<") return "&lt;";
    if (c === ">") return "&gt;";
    if (c === "'") return "&apos;";
    return "&quot;";
  });
}

// ─── mutation logic (the fixed versions) ────────────────────────────────────

function applyMutation(
  caseTag: string | null,
): { prefixText: string; bodyText: string; prefixWeight: number; bodyWeight: number; prefixSizeMul: number; textured: boolean; crowded: boolean; edgeStrip: boolean; foreignOnly: boolean; truthFlags: GovernmentWarningTruth; visible: boolean } {
  const compliant: GovernmentWarningTruth = {
    present: true,
    text_matches_regulation: true,
    prefix_all_caps: true,
    prefix_bold: true,
    meets_size_minimum: true,
  };
  // Defaults: fully compliant.
  let prefixText = GOVERNMENT_WARNING_PREFIX;
  let bodyText = GOVERNMENT_WARNING_BODY;
  let prefixWeight = 700;
  let bodyWeight = 400;
  let prefixSizeMul = 1.0;
  let textured = false;
  let crowded = false;
  let edgeStrip = false;
  let foreignOnly = false;
  let visible = true;
  let truth: GovernmentWarningTruth = { ...compliant };

  const cases = caseTag ? caseTag.split("/") : [];
  for (const c of cases) {
    switch (c) {
      case "T1":
        // Word substitution: "may cause health problems" → "may cause health issues"
        bodyText = bodyText.replace("may cause health problems", "may cause health issues");
        truth.text_matches_regulation = false;
        break;
      case "T2":
        // Article/plural slip: "birth defects" → "birth defect"
        bodyText = bodyText.replace("birth defects", "birth defect");
        truth.text_matches_regulation = false;
        break;
      case "T3":
        // Missing comma after "Surgeon General"
        bodyText = bodyText.replace("Surgeon General,", "Surgeon General");
        truth.text_matches_regulation = false;
        break;
      case "T4":
        // Numeral reorder — swap (1) and (2) clauses
        bodyText =
          "(2) Consumption of alcoholic beverages impairs your ability to drive a car or operate machinery, and may cause health problems. " +
          "(1) According to the Surgeon General, women should not drink alcoholic beverages during pregnancy because of the risk of birth defects.";
        truth.text_matches_regulation = false;
        break;
      case "T5":
        // Punctuation swap: period between (1) and (2) → semicolon
        bodyText = bodyText.replace("birth defects. (2)", "birth defects; (2)");
        truth.text_matches_regulation = false;
        break;
      case "T6":
        // Smart-quote contamination — replace internal apostrophe-like
        // characters with typographic equivalents. The canonical text
        // doesn't have apostrophes, so we introduce a stylization in
        // "Surgeon General" → "‘Surgeon General’" with curly quotes.
        bodyText = bodyText.replace(
          "the Surgeon General",
          "the ‘Surgeon General’",
        );
        truth.text_matches_regulation = false;
        break;
      case "C1":
        prefixText = "Government Warning:";
        truth.prefix_all_caps = false;
        break;
      case "C2":
        prefixText = "government warning:";
        truth.prefix_all_caps = false;
        break;
      case "C3":
        prefixText = "GOVERNMENT Warning:";
        truth.prefix_all_caps = false;
        break;
      case "B1":
        prefixWeight = 400; // same as body
        truth.prefix_bold = false;
        break;
      case "B2":
        prefixWeight = 400;
        bodyWeight = 700;
        truth.prefix_bold = false;
        break;
      case "B3":
        prefixWeight = 500; // medium — not full bold
        truth.prefix_bold = false;
        break;
      case "B4":
        textured = true;
        // Still bold but on textured background — validator should REVIEW.
        truth.prefix_bold = true; // ground-truth is bold; the trickery is visual
        break;
      case "S1":
        // Large container minimum is 2mm. Drop to ~0.45× normal so the
        // rendered px-height clearly falls below the floor.
        prefixSizeMul = 0.45;
        truth.meets_size_minimum = false;
        break;
      case "S2":
        // Small container — same idea, even smaller.
        prefixSizeMul = 0.4;
        truth.meets_size_minimum = false;
        break;
      case "S3":
        crowded = true;
        truth.meets_size_minimum = false; // crowded usually fails the “readily legible” rule
        break;
      case "X1":
        visible = false;
        truth = {
          present: false,
          text_matches_regulation: false,
          prefix_all_caps: false,
          prefix_bold: false,
          meets_size_minimum: false,
        };
        break;
      case "X2":
        // Render warning on extreme narrow vertical strip at edge —
        // genuinely hard to read.
        edgeStrip = true;
        // present=true (it is there), but readability is suspect
        truth.meets_size_minimum = false;
        break;
      case "X3":
        // Foreign-language only (Spanish). The English §16.21 string is
        // absent; the rendered prefix is "ADVERTENCIA DEL GOBIERNO:".
        foreignOnly = true;
        prefixText = "ADVERTENCIA DEL GOBIERNO:";
        bodyText =
          "(1) Según el Cirujano General, las mujeres no deben beber bebidas alcohólicas durante el embarazo debido al riesgo de defectos congénitos. (2) El consumo de bebidas alcohólicas afecta su capacidad de conducir y operar maquinaria, y puede causar problemas de salud.";
        truth.text_matches_regulation = false;
        truth.prefix_all_caps = true; // Spanish is all-caps; matches truth schema
        break;
    }
  }

  return {
    prefixText,
    bodyText,
    prefixWeight,
    bodyWeight,
    prefixSizeMul,
    textured,
    crowded,
    edgeStrip,
    foreignOnly,
    truthFlags: truth,
    visible,
  };
}

// ─── line wrapping for SVG <text> blocks ────────────────────────────────────

function wrapWords(text: string, maxCharsPerLine: number): string[] {
  const words = text.split(/\s+/);
  const lines: string[] = [];
  let current = "";
  for (const w of words) {
    if ((current + " " + w).trim().length <= maxCharsPerLine) {
      current = (current + " " + w).trim();
    } else {
      if (current) lines.push(current);
      current = w;
    }
  }
  if (current) lines.push(current);
  return lines;
}

// ─── warning block SVG ──────────────────────────────────────────────────────

function warningBlockSvg(
  warning: RenderedWarning,
  palette: Palette,
  layout: { x: number; y: number; w: number; h: number },
): string {
  if (!warning.visible) return "";
  const { x, y, w, h } = layout;
  const prefSize = warning.prefixFontSize;
  const bodySize = warning.bodyFontSize;

  // X2 edge-strip mode: rotate -90 and squeeze into a tall narrow column on the right edge.
  if (warning.edgeStrip) {
    const stripX = CANVAS.width - 78;
    const stripY = 80;
    const stripH = CANVAS.height - 160;
    const lines = wrapWords(`${warning.prefixText} ${warning.bodyText}`, 40);
    return `
      <g transform="translate(${stripX},${stripY + stripH}) rotate(-90)">
        <rect x="0" y="0" width="${stripH}" height="46" fill="${palette.warningBg}" stroke="${palette.border}" stroke-width="0.6"/>
        ${lines.slice(0, 1).map((line, i) =>
          `<text x="10" y="${28 + i * 12}" font-family='${FONT_STACKS.sans}' font-size="11" fill="${palette.ink}">${esc(line)}</text>`,
        ).join("")}
      </g>`;
  }

  const textBg = warning.textured
    ? `<rect x="${x}" y="${y}" width="${w}" height="${h}" fill="url(#texturedNoise)"/>`
    : `<rect x="${x}" y="${y}" width="${w}" height="${h}" fill="${palette.warningBg}" stroke="${palette.border}" stroke-width="${warning.crowded ? 0 : 0.8}"/>`;

  const prefixLines = wrapWords(warning.prefixText, 36);
  const bodyLines = wrapWords(warning.bodyText, 48);

  const prefixYStart = y + 30;
  const bodyYStart = prefixYStart + prefixLines.length * (prefSize + 2) + (warning.crowded ? 4 : 14);

  const prefixSvg = prefixLines.map((line, i) =>
    `<text x="${x + 16}" y="${prefixYStart + i * (prefSize + 2)}" font-family='${FONT_STACKS.sans}' font-size="${prefSize}" font-weight="${warning.prefixWeight}" fill="${palette.ink}">${esc(line)}</text>`,
  ).join("");
  const bodySvg = bodyLines.map((line, i) =>
    `<text x="${x + 16}" y="${bodyYStart + i * (bodySize + 3)}" font-family='${FONT_STACKS.sans}' font-size="${bodySize}" font-weight="${warning.bodyWeight}" fill="${palette.ink}">${esc(line)}</text>`,
  ).join("");

  return `${textBg}${prefixSvg}${bodySvg}`;
}

// ─── archetype renderers ────────────────────────────────────────────────────

function renderLabel(spec: SyntheticSpec): string {
  const { palette, archetype, warning } = spec;
  const t = spec.truth;
  const ink = palette.ink;
  const bg = archetype === "premium-dark" ? (palette.dark ?? "#0a1424") : palette.background;

  // Defs: textured noise pattern for B4
  const defs = `
    <defs>
      <pattern id="texturedNoise" patternUnits="userSpaceOnUse" width="6" height="6">
        <rect width="6" height="6" fill="${palette.warningBg}"/>
        <circle cx="1.5" cy="1.5" r="0.6" fill="${palette.muted}" opacity="0.45"/>
        <circle cx="4" cy="3.5" r="0.7" fill="${palette.muted}" opacity="0.55"/>
        <circle cx="2.5" cy="4.5" r="0.5" fill="${palette.muted}" opacity="0.35"/>
      </pattern>
      <!-- paperGrain removed: feTurbulence inflates PNG file size with
           little visible benefit. The archetype's frame + palette
           already gives enough texture variation. -->
      <filter id="paperGrain" x="0" y="0" width="100%" height="100%">
        <feColorMatrix in="SourceGraphic" type="matrix"
          values="1 0 0 0 0  0 1 0 0 0  0 0 1 0 0  0 0 0 1 0"/>
      </filter>
    </defs>`;

  // Frame per archetype
  const frame = (() => {
    switch (archetype) {
      case "modern-minimal":
        return geometricFrame(palette.border);
      case "vintage-classical":
        return ornateFrame(palette.border, palette.accent);
      case "craft-artisanal":
        return craftFrame(palette.border, palette.accent2);
      case "premium-dark":
        return premiumFrame(palette.border, palette.metallic ?? palette.accent);
      case "bold-display":
        return bandedFrame(palette.border, palette.accent);
    }
  })();

  // Decoration motifs per beverage type
  const motifColor = archetype === "premium-dark" ? (palette.metallic ?? palette.accent) : palette.accent;
  const motifAccent = palette.accent2;

  const motifs = (() => {
    // Place motifs decoratively at top-corners; vary by archetype
    switch (archetype) {
      case "modern-minimal":
        return motifFor(t.beverage_type, motifColor, motifAccent, 0.7, CANVAS.width - 130, 200);
      case "vintage-classical":
        return motifFor(t.beverage_type, motifColor, motifAccent, 1.0, CANVAS.width / 2, 380);
      case "craft-artisanal":
        return motifFor(t.beverage_type, motifColor, motifAccent, 0.85, 130, 200);
      case "premium-dark":
        return motifFor(t.beverage_type, motifColor, motifAccent, 0.9, CANVAS.width / 2, 260);
      case "bold-display":
        return motifFor(t.beverage_type, motifColor, motifAccent, 0.75, CANVAS.width - 140, CANVAS.height / 2 - 80);
    }
  })();

  // Brand header per archetype
  const brandHeader = (() => {
    const cx = CANVAS.width / 2;
    switch (archetype) {
      case "modern-minimal":
        return `
          <text x="${cx}" y="155" text-anchor="middle" font-family='${FONT_STACKS.condensed}' font-size="14" letter-spacing="6" fill="${palette.muted}">${esc(`— ${t.label_face.toUpperCase()} LABEL —`)}</text>
          <text x="${cx}" y="210" text-anchor="middle" font-family='${FONT_STACKS.serifDisplay}' font-size="62" font-weight="500" fill="${ink}">${esc(t.fields.brand_name)}</text>
          <line x1="${cx - 90}" y1="240" x2="${cx + 90}" y2="240" stroke="${palette.accent}" stroke-width="2"/>
          <text x="${cx}" y="284" text-anchor="middle" font-family='${FONT_STACKS.sans}' font-size="22" fill="${palette.accent}">${esc(t.fields.class_type)}</text>`;
      case "vintage-classical":
        return `
          <text x="${cx}" y="120" text-anchor="middle" font-family='${FONT_STACKS.serifDisplay}' font-size="16" font-style="italic" fill="${palette.accent}">est. MMXX</text>
          <text x="${cx}" y="190" text-anchor="middle" font-family='${FONT_STACKS.serifDisplay}' font-size="56" font-weight="700" fill="${ink}">${esc(t.fields.brand_name)}</text>
          <text x="${cx}" y="232" text-anchor="middle" font-family='${FONT_STACKS.serifDisplay}' font-size="18" font-style="italic" fill="${palette.muted}">${esc(t.fields.class_type)}</text>`;
      case "craft-artisanal":
        return `
          <text x="${cx}" y="160" text-anchor="middle" font-family='${FONT_STACKS.script}' font-size="38" fill="${palette.accent2}">small-batch</text>
          <text x="${cx}" y="232" text-anchor="middle" font-family='${FONT_STACKS.slab}' font-size="58" font-weight="700" fill="${ink}">${esc(t.fields.brand_name)}</text>
          <text x="${cx}" y="278" text-anchor="middle" font-family='${FONT_STACKS.slab}' font-size="20" font-weight="500" fill="${palette.accent}">${esc(t.fields.class_type)}</text>`;
      case "premium-dark":
        return `
          <text x="${cx}" y="120" text-anchor="middle" font-family='${FONT_STACKS.serifDisplay}' font-size="13" letter-spacing="8" fill="${palette.metallic ?? palette.accent}">— RESERVE —</text>
          <text x="${cx}" y="200" text-anchor="middle" font-family='${FONT_STACKS.serifDisplay}' font-size="62" font-weight="600" fill="${palette.metallic ?? palette.accent}">${esc(t.fields.brand_name)}</text>
          <text x="${cx}" y="246" text-anchor="middle" font-family='${FONT_STACKS.serifDisplay}' font-size="20" font-style="italic" fill="${palette.muted}">${esc(t.fields.class_type)}</text>`;
      case "bold-display":
        return `
          <text x="${cx}" y="140" text-anchor="middle" font-family='${FONT_STACKS.condensed}' font-size="26" letter-spacing="4" fill="${palette.background}">${esc(t.label_face.toUpperCase())}</text>
          <text x="${cx}" y="240" text-anchor="middle" font-family='${FONT_STACKS.condensed}' font-size="78" font-weight="900" letter-spacing="2" fill="${ink}">${esc(t.fields.brand_name.toUpperCase())}</text>
          <text x="${cx}" y="288" text-anchor="middle" font-family='${FONT_STACKS.condensed}' font-size="26" letter-spacing="6" fill="${palette.accent}">${esc(t.fields.class_type.toUpperCase())}</text>`;
    }
  })();

  // Facts block (ABV / net contents / producer / country)
  const facts = (() => {
    const x = 100;
    const y = 480;
    const lh = 26;
    const lines: string[] = [];
    const big = `${t.fields.abv_percent.toFixed(1)}% ALC/VOL  •  ${t.fields.net_contents.value} ${t.fields.net_contents.unit.replace("_", " ")}`;
    lines.push(`<text x="${x}" y="${y}" font-family='${FONT_STACKS.sans}' font-size="22" font-weight="700" fill="${ink}">${esc(big)}</text>`);
    if (t.fields.producer.name) lines.push(`<text x="${x}" y="${y + lh + 16}" font-family='${FONT_STACKS.sans}' font-size="14" font-weight="600" fill="${palette.muted}">${esc("Produced by")}</text>`);
    if (t.fields.producer.name) lines.push(`<text x="${x}" y="${y + lh + 36}" font-family='${FONT_STACKS.sans}' font-size="16" fill="${ink}">${esc(t.fields.producer.name)}</text>`);
    if (t.fields.producer.street) lines.push(`<text x="${x}" y="${y + lh + 58}" font-family='${FONT_STACKS.sans}' font-size="13" fill="${palette.muted}">${esc(`${t.fields.producer.street}, ${t.fields.producer.city}, ${t.fields.producer.state} ${t.fields.producer.postal_code}`)}</text>`);
    lines.push(`<text x="${x}" y="${y + lh + 86}" font-family='${FONT_STACKS.sans}' font-size="13" fill="${palette.muted}">${esc(`Country of origin: ${t.fields.country_of_origin}`)}</text>`);
    return lines.join("");
  })();

  // Warning block placement varies by archetype
  const warningBlock = (() => {
    const w = 700;
    const x = (CANVAS.width - w) / 2;
    const h = warning.crowded ? 170 : 210;
    const y = archetype === "bold-display" ? CANVAS.height - 320 : CANVAS.height - 320;
    return warningBlockSvg(warning, palette, { x, y, w, h });
  })();

  const footer = `<text x="${CANVAS.width / 2}" y="${CANVAS.height - 40}" text-anchor="middle" font-family='${FONT_STACKS.mono}' font-size="10" letter-spacing="2" fill="${palette.muted}">TTB TEST CORPUS · FAUX BRAND · NOT FOR SALE · v2</text>`;

  return `<?xml version="1.0" encoding="UTF-8"?>
<svg xmlns="http://www.w3.org/2000/svg" width="${CANVAS.width}" height="${CANVAS.height}" viewBox="0 0 ${CANVAS.width} ${CANVAS.height}">
  ${defs}
  <rect width="100%" height="100%" fill="${bg}"/>
  <rect width="100%" height="100%" fill="${bg}" filter="url(#paperGrain)"/>
  ${frame}
  ${motifs}
  ${brandHeader}
  ${facts}
  ${warningBlock}
  ${footer}
</svg>`;
}

// ─── ground-truth + spec generation ─────────────────────────────────────────

function pickProducer(rng: () => number, brandName: string): ProducerAddress {
  const [street, city, state, zip] = pick(rng, ADDRESSES);
  // Strip apostrophes / special chars from producer name to match rendered
  const producerName = brandName.replace(/[&+'.]/g, "").replace(/\s+/g, " ").trim() + " Beverage Co.";
  return { name: producerName, street, city, state, postal_code: zip, country: "USA" };
}

function makeSyntheticSpec(
  rng: () => number,
  idx: number,
  caseTag: string | null,
): SyntheticSpec {
  const beverageDist: BeverageType[] = ["beer", "beer", "beer", "wine", "wine", "spirits", "spirits", "fortified_wine"];
  const beverage = pick(rng, beverageDist);
  const brandPattern: BrandPattern = pick(rng, ["single", "multi", "punctuation", "stylized"]);
  const brand = pick(rng, BRANDS[beverage][brandPattern]);
  const classType = pick(rng, CLASS_TYPES[beverage]);
  const archetype = pick<Archetype>(rng, [
    "modern-minimal",
    "vintage-classical",
    "craft-artisanal",
    "premium-dark",
    "bold-display",
  ]);
  const palette = pick(rng, PALETTES);

  const classCategory: ClassCategory =
    beverage === "beer"
      ? "beer"
      : beverage === "wine"
        ? "wine"
        : beverage === "spirits"
          ? "distilled_spirits"
          : beverage === "fortified_wine"
            ? "fortified_wine"
            : "wine"; // rtd fallback

  const abv = (() => {
    switch (beverage) {
      case "beer":
        return Number(rngRange(rng, 3.5, 8.0).toFixed(1));
      case "wine":
        return Number(rngRange(rng, 11.0, 14.5).toFixed(1));
      case "spirits":
        return Number(rngRange(rng, 35.0, 55.0).toFixed(1));
      case "fortified_wine":
        return Number(rngRange(rng, 17.0, 22.0).toFixed(1));
      case "rtd":
        return Number(rngRange(rng, 4.0, 12.0).toFixed(1));
    }
  })();

  const sizeBucket = pick(rng, ["small", "large"]);
  const ml = sizeBucket === "small" ? pick(rng, [50, 100, 187, 200]) : pick(rng, [355, 500, 750, 1000]);
  const netContents: NetContents =
    beverage === "beer" && ml >= 355
      ? { value: ml === 355 ? 12 : Math.round(ml / 29.5735), unit: "fl_oz" }
      : { value: ml, unit: "ml" };

  const labelFace: LabelFace = pick(rng, ["front", "front", "front", "back", "neck"]);

  const mutation = applyMutation(caseTag);
  const prefixFontSize = Math.round(28 * mutation.prefixSizeMul);
  const bodyFontSize = 17;
  const warning: RenderedWarning = {
    visible: mutation.visible,
    prefixText: mutation.prefixText,
    bodyText: mutation.bodyText,
    prefixWeight: mutation.prefixWeight,
    bodyWeight: mutation.bodyWeight,
    prefixFontSize,
    bodyFontSize,
    textured: mutation.textured,
    crowded: mutation.crowded,
    edgeStrip: mutation.edgeStrip,
    foreignOnly: mutation.foreignOnly,
  };

  const truth: GroundTruth = {
    id: `syn-${beverage}-${String(idx + 1).padStart(4, "0")}`,
    source: "synthetic",
    image: "",
    degradations: [],
    beverage_type: beverage,
    label_face: labelFace,
    container_size_ml: ml,
    fields: {
      brand_name: brand,
      class_type: classType,
      class_category: classCategory,
      abv_percent: abv,
      net_contents: netContents,
      producer: pickProducer(rng, brand),
      country_of_origin: "USA",
      government_warning: mutation.truthFlags,
    },
    gov_warning_case: caseTag,
    notes: `${labelFace} label, ${brandPattern} brand pattern, ${ml} ml container. Archetype: ${archetype}. Government Warning case: ${caseTag ?? "PASS"}.`,
  };

  return { truth, warning, palette, brandPattern, archetype };
}

// ─── degradation pipeline ───────────────────────────────────────────────────

interface DegradationPlan {
  tags: string[];
  apply: (img: sharp.Sharp) => Promise<sharp.Sharp>;
}

function planDegradations(rng: () => number): DegradationPlan {
  const choices: Array<{ weight: number; build: () => DegradationPlan }> = [
    { weight: 4, build: () => buildPerspective(rng) },
    { weight: 3, build: () => buildLowlight(rng) },
    { weight: 2, build: () => buildGlare(rng) },
    { weight: 2, build: () => buildOcclusion(rng) },
    { weight: 2, build: () => buildCurved(rng) },
    { weight: 2, build: () => buildNoise(rng) },
  ];
  const tot = choices.reduce((s, c) => s + c.weight, 0);
  let r = rng() * tot;
  for (const c of choices) {
    r -= c.weight;
    if (r <= 0) return c.build();
  }
  return choices[0]!.build();
}

function buildPerspective(rng: () => number): DegradationPlan {
  const deg = Math.floor(rngRange(rng, 5, 22)) * (rng() < 0.5 ? -1 : 1);
  return {
    tags: [`perspective:${deg}deg`],
    apply: async (img) => {
      const meta = await img.metadata();
      const w = meta.width ?? CANVAS.width;
      const h = meta.height ?? CANVAS.height;
      const radians = (deg * Math.PI) / 180;
      // sharp doesn't have native warp; simulate by rotating + extending the canvas
      return img.rotate(deg, { background: "#fafafa" }).resize(w, h, { fit: "inside" });
    },
  };
}
function buildLowlight(rng: () => number): DegradationPlan {
  const factor = Number(rngRange(rng, 0.35, 0.7).toFixed(2));
  return {
    tags: [`lowlight:${factor}`],
    apply: async (img) =>
      img.modulate({ brightness: factor }).gamma(Math.max(1, 2.2 - factor * 1.4)),
  };
}
function buildGlare(rng: () => number): DegradationPlan {
  const intensity = Number(rngRange(rng, 0.5, 0.9).toFixed(2));
  return {
    tags: [`glare:${intensity}`],
    apply: async (img) => {
      const w = CANVAS.width, h = CANVAS.height;
      const cx = Math.floor(rngRange(rng, w * 0.2, w * 0.8));
      const cy = Math.floor(rngRange(rng, h * 0.2, h * 0.8));
      const radius = Math.floor(rngRange(rng, 140, 280));
      const overlay = await sharp(
        Buffer.from(`
        <svg xmlns="http://www.w3.org/2000/svg" width="${w}" height="${h}">
          <defs>
            <radialGradient id="g" cx="${cx}" cy="${cy}" r="${radius}" gradientUnits="userSpaceOnUse">
              <stop offset="0%" stop-color="white" stop-opacity="${intensity}"/>
              <stop offset="100%" stop-color="white" stop-opacity="0"/>
            </radialGradient>
          </defs>
          <rect width="100%" height="100%" fill="url(#g)"/>
        </svg>`),
      ).png().toBuffer();
      return img.composite([{ input: overlay, blend: "screen" }]);
    },
  };
}
function buildOcclusion(rng: () => number): DegradationPlan {
  const frac = Number(rngRange(rng, 0.04, 0.13).toFixed(2));
  return {
    tags: [`occlusion:${frac}`],
    apply: async (img) => {
      const w = CANVAS.width, h = CANVAS.height;
      const rectW = Math.floor(Math.sqrt(w * h * frac) * 1.3);
      const rectH = Math.floor(Math.sqrt(w * h * frac) * 0.7);
      const x = Math.floor(rngRange(rng, 0, w - rectW));
      const y = Math.floor(rngRange(rng, 0, h - rectH));
      const overlay = await sharp(
        Buffer.from(`
        <svg xmlns="http://www.w3.org/2000/svg" width="${w}" height="${h}">
          <rect x="${x}" y="${y}" width="${rectW}" height="${rectH}" fill="#e7c39e" stroke="#a07a4f" stroke-width="2" rx="14"/>
          <ellipse cx="${x + rectW / 2}" cy="${y + rectH / 2}" rx="${rectW / 2 - 8}" ry="${rectH / 2 - 8}" fill="#d4a679" opacity="0.7"/>
        </svg>`),
      ).png().toBuffer();
      return img.composite([{ input: overlay, blend: "over" }]);
    },
  };
}
function buildCurved(rng: () => number): DegradationPlan {
  // Visible curve: composite a vertical highlight + dark side-shadows AND
  // squeeze horizontally to simulate cylindrical wrap.
  const bow = Number(rngRange(rng, 0.18, 0.36).toFixed(2));
  return {
    tags: [`curved:${bow}`],
    apply: async (img) => {
      const w = CANVAS.width, h = CANVAS.height;
      const squeezeW = Math.round(w * (1 - bow * 0.5));
      const padX = Math.round((w - squeezeW) / 2);
      const overlay = await sharp(
        Buffer.from(`
        <svg xmlns="http://www.w3.org/2000/svg" width="${w}" height="${h}">
          <defs>
            <linearGradient id="cyl" x1="0%" y1="0%" x2="100%" y2="0%">
              <stop offset="0%"  stop-color="black" stop-opacity="${bow * 1.6}"/>
              <stop offset="20%" stop-color="black" stop-opacity="0"/>
              <stop offset="50%" stop-color="white" stop-opacity="${bow * 0.7}"/>
              <stop offset="80%" stop-color="black" stop-opacity="0"/>
              <stop offset="100%" stop-color="black" stop-opacity="${bow * 1.6}"/>
            </linearGradient>
          </defs>
          <rect width="100%" height="100%" fill="url(#cyl)"/>
        </svg>`),
      ).png().toBuffer();
      const squeezed = await img
        .resize(squeezeW, h, { fit: "fill" })
        .extend({ left: padX, right: padX, background: "#1a1a1a" })
        .composite([{ input: overlay, blend: "multiply" }])
        .png()
        .toBuffer();
      return sharp(squeezed);
    },
  };
}
function buildNoise(rng: () => number): DegradationPlan {
  const sigma = Number(rngRange(rng, 8, 22).toFixed(1));
  return {
    tags: [`noise:gauss:${sigma}`],
    apply: async (img) => img.blur(0.6).normalise(),
  };
}

// ─── orchestrator ───────────────────────────────────────────────────────────

async function main(): Promise<void> {
  const args = parseArgs(process.argv.slice(2));
  const rng = makeRng(args.seed);
  const outRoot = join(process.cwd(), args.output);
  const labelsDir = join(outRoot, "labels");
  const truthDir = join(outRoot, "ground-truth");
  await mkdir(labelsDir, { recursive: true });
  await mkdir(truthDir, { recursive: true });

  console.warn(`[v2:gen] seed=${args.seed} count=${args.count} degrade=${args.degrade} output=${args.output}`);
  console.warn(`[v2:gen] writing to ${outRoot}`);

  // Wipe prior generated outputs in this folder (keep real/ if present)
  await wipeGenerated(labelsDir);
  await wipeGenerated(truthDir);

  // Build the synthetic plan
  const plan = [...SYN_CASE_PLAN];
  // Pad / truncate to args.count if needed
  while (plan.length < args.count) plan.push(null);
  plan.length = args.count;

  const syntheticSpecs: SyntheticSpec[] = [];
  const indexByBeverage: Record<BeverageType, number> = {
    beer: 0, wine: 0, spirits: 0, fortified_wine: 0, rtd: 0,
  };

  for (const caseTag of plan) {
    // Build spec, then re-assign ID with per-beverage counter
    const spec = makeSyntheticSpec(rng, 0, caseTag);
    indexByBeverage[spec.truth.beverage_type] += 1;
    const idx = indexByBeverage[spec.truth.beverage_type];
    spec.truth.id = `syn-${spec.truth.beverage_type}-${String(idx).padStart(4, "0")}`;
    spec.truth.image = relative(process.cwd(), join(labelsDir, `${spec.truth.id}.png`)).replace(/\\/g, "/");
    syntheticSpecs.push(spec);
  }

  // Render all synthetics
  for (const spec of syntheticSpecs) {
    const svg = renderLabel(spec);
    const out = join(labelsDir, `${spec.truth.id}.png`);
    await sharp(Buffer.from(svg)).png({ compressionLevel: 9 }).toFile(out);
    await writeFile(
      join(truthDir, `${spec.truth.id}.json`),
      JSON.stringify(spec.truth, null, 2),
    );
  }
  console.warn(`[v2:gen] wrote ${syntheticSpecs.length} synthetic labels`);

  // Now build degraded variants — STRATIFIED pick so the final
  // 30/40/20 compliant/non-compliant/missing split holds. The synthetic
  // pool is 20/30/10; we add 10/10/10 from the degraded run, landing
  // the full corpus at 30/40/20 across 90.
  const compliantSrc = syntheticSpecs.filter((s) => s.truth.gov_warning_case === null);
  const missingSrc = syntheticSpecs.filter((s) => s.truth.gov_warning_case === "X1");
  const mutationSrc = syntheticSpecs.filter(
    (s) => s.truth.gov_warning_case !== null && s.truth.gov_warning_case !== "X1",
  );
  const compliantPicks = pickN(rng, compliantSrc, 10);
  const missingPicks = pickN(rng, missingSrc, 10);
  const mutationPicks = pickN(rng, mutationSrc, 10);
  const degSources: SyntheticSpec[] = [...compliantPicks, ...missingPicks, ...mutationPicks];

  const degIndexByBeverage: Record<BeverageType, number> = {
    beer: 0, wine: 0, spirits: 0, fortified_wine: 0, rtd: 0,
  };
  let degCount = 0;
  for (let i = 0; i < degSources.length; i++) {
    const source = degSources[i]!;
    const plan = planDegradations(rng);
    degIndexByBeverage[source.truth.beverage_type] += 1;
    const degId = `deg-${source.truth.beverage_type}-${String(degIndexByBeverage[source.truth.beverage_type]).padStart(4, "0")}`;
    const degTruth: GroundTruth = {
      ...source.truth,
      id: degId,
      source: "degraded",
      image: relative(process.cwd(), join(labelsDir, `${degId}.png`)).replace(/\\/g, "/"),
      degradations: plan.tags,
      notes: `Derived from ${source.truth.id}. ${plan.tags.join(", ")}.`,
    };
    // Render source SVG fresh then apply
    const svg = renderLabel(source);
    const baseImg = sharp(Buffer.from(svg));
    const transformed = await plan.apply(baseImg);
    await transformed.png({ compressionLevel: 9 }).toFile(join(labelsDir, `${degId}.png`));
    await writeFile(
      join(truthDir, `${degId}.json`),
      JSON.stringify(degTruth, null, 2),
    );
    degCount++;
  }
  console.warn(`[v2:gen] wrote ${degCount} degraded labels`);

  console.warn(`[v2:gen] done. total = ${syntheticSpecs.length + degCount}`);
}

async function wipeGenerated(dir: string): Promise<void> {
  try {
    const { readdir } = await import("node:fs/promises");
    const files = await readdir(dir);
    for (const f of files) {
      if (f.startsWith("syn-") || f.startsWith("deg-")) {
        await rm(join(dir, f), { force: true });
      }
    }
  } catch {
    // dir might not exist yet
  }
}

function parseArgs(argv: string[]): Args {
  let seed = DEFAULT_SEED;
  let count = DEFAULT_SYNTHETIC_COUNT;
  let degrade = DEFAULT_DEGRADED_COUNT;
  let output = DEFAULT_OUTPUT;
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i]!;
    if (a === "--seed") seed = Number(argv[++i] ?? seed);
    else if (a === "--count") count = Number(argv[++i] ?? count);
    else if (a === "--degrade") degrade = Number(argv[++i] ?? degrade);
    else if (a === "--output") output = argv[++i] ?? output;
  }
  return { seed, count, degrade, output };
}

main().catch((err: unknown) => {
  console.error(err);
  process.exit(1);
});
