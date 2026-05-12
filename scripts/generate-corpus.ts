import { mkdir, readdir, rm, writeFile } from "node:fs/promises";
import { join, relative } from "node:path";
import sharp from "sharp";

const CANVAS = { width: 900, height: 1200 };
const DEFAULT_SEED = 42;
const DEFAULT_SYNTHETIC_COUNT = 60;
const DEFAULT_DEGRADED_COUNT = 30;
const DEFAULT_OUTPUT = "test-data";

const GOVERNMENT_WARNING_PREFIX = "GOVERNMENT WARNING:";
const GOVERNMENT_WARNING_BODY =
  "(1) According to the Surgeon General, women should not drink alcoholic beverages during pregnancy because of the risk of birth defects. (2) Consumption of alcoholic beverages impairs your ability to drive a car or operate machinery, and may cause health problems.";
const GOVERNMENT_WARNING_FULL = `${GOVERNMENT_WARNING_PREFIX} ${GOVERNMENT_WARNING_BODY}`;

type Source = "synthetic" | "degraded" | "real";
type BeverageType = "beer" | "wine" | "spirits" | "fortified_wine" | "rtd";
type ClassCategory = "beer" | "wine" | "distilled_spirits" | "fortified_wine";
type LabelFace = "front" | "back" | "neck";
type NetUnit = "fl_oz" | "ml" | "L" | "cl";
type BrandPattern = "single" | "multi" | "punctuation" | "stylized";

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

interface SyntheticSpec {
  truth: GroundTruth;
  warning: RenderedWarning;
  palette: Palette;
  brandPattern: BrandPattern;
  layoutVariant: number;
}

interface RenderedWarning {
  visible: boolean;
  prefixText: string;
  bodyText: string;
  prefixWeight: number;
  bodyWeight: number;
  prefixFontSize: number;
  bodyFontSize: number;
  textured: boolean;
  crowded: boolean;
  arc: boolean;
  foreignOnly: boolean;
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
}

interface Args {
  seed: number;
  count: number;
  degrade: number;
  output: string;
}

const palettes: Palette[] = [
  {
    background: "#f2f5f7",
    panel: "#fffaf2",
    ink: "#1f2933",
    muted: "#5b6470",
    accent: "#0f766e",
    accent2: "#d97706",
    warningBg: "#fff7ed",
    border: "#22313f",
  },
  {
    background: "#eef2ff",
    panel: "#ffffff",
    ink: "#111827",
    muted: "#4b5563",
    accent: "#1d4ed8",
    accent2: "#be123c",
    warningBg: "#f8fafc",
    border: "#1e3a8a",
  },
  {
    background: "#f7fee7",
    panel: "#fffff4",
    ink: "#1c1917",
    muted: "#57534e",
    accent: "#4d7c0f",
    accent2: "#7c2d12",
    warningBg: "#fafaf9",
    border: "#365314",
  },
  {
    background: "#faf5ff",
    panel: "#fff7f2",
    ink: "#18181b",
    muted: "#52525b",
    accent: "#7f1d1d",
    accent2: "#0369a1",
    warningBg: "#fff1f2",
    border: "#3f3f46",
  },
  {
    background: "#ecfeff",
    panel: "#fdfdf8",
    ink: "#0f172a",
    muted: "#475569",
    accent: "#155e75",
    accent2: "#a16207",
    warningBg: "#f0f9ff",
    border: "#164e63",
  },
  {
    background: "#f8fafc",
    panel: "#f7f0df",
    ink: "#292524",
    muted: "#57534e",
    accent: "#92400e",
    accent2: "#166534",
    warningBg: "#eee0c4",
    border: "#44403c",
  },
];

const brands: Record<BeverageType, Record<BrandPattern, string[]>> = {
  beer: {
    single: ["Bluerose", "Headlands", "Sundial", "Cairnmark", "Fieldstone"],
    multi: ["Mill Creek", "Tin Roof", "Cold Iron", "Old Cypress", "Latitude Seven"],
    punctuation: ["Stone's Throw", "O'Reilly Hollow", "Field & Bramble", "Rust & Ember", "Half-Note"],
    stylized: ["STONE'S THROW", "TIN ROOF", "COLD IRON", "OLD CYPRESS", "LATITUDE 7"],
  },
  wine: {
    single: ["Vespera", "Argenton", "Halfwild", "Saltwood", "Bertelli"],
    multi: ["Marbled Hills", "Mira Vista", "Calder Estates", "Solano Reach", "Old Schoolhouse"],
    punctuation: ["Roan & Stone", "Five Sisters", "Mt. Frieda Cellars", "Cote du Soir", "Castelo do Vento"],
    stylized: ["VESPERA", "MARBLED HILLS", "MIRA VISTA", "CALDER ESTATES", "SOLANO REACH"],
  },
  spirits: {
    single: ["Saltgrass", "Northmast", "Longwhistle", "Vidalia", "Cloister"],
    multi: ["Six Foxes", "Cloister Hill", "Vagrant Tide", "Black Cardamom", "Iron Magnolia"],
    punctuation: ["Ashby & Drake", "Marrow & Bone", "Mercer's Reserve", "Tarn & Heath", "Fox's Lantern"],
    stylized: ["SIX FOXES", "CLOISTER HILL", "BLACK CARDAMOM", "IRON MAGNOLIA", "SALTGRASS"],
  },
  fortified_wine: {
    single: ["Solstice", "Sunbeam", "Marin", "Madrona", "Vermella"],
    multi: ["Solstice Vermouth", "Cave Marin", "Sunbeam Spritz", "Harbor Madeira", "Mesa Sherry"],
    punctuation: ["Hibiscus + Salt", "Madrona Port", "Cave & Coast", "Solstice No. 7", "North & Fig"],
    stylized: ["SOLSTICE VERMOUTH", "CAVE MARIN", "SUNBEAM SPRITZ", "MADRON PORT", "HIBISCUS + SALT"],
  },
  rtd: {
    single: ["Sunbeam", "Briskly", "Hearth", "Beryl", "Palisade"],
    multi: ["Sunbeam Spritz", "Hibiscus Salt", "Garden Highball", "Citrus Range", "Harbor Fizz"],
    punctuation: ["Hibiscus + Salt", "Lemon & Bay", "Juniper No. 3", "Citrus & Rye", "Rose + Tonic"],
    stylized: ["SUNBEAM SPRITZ", "HIBISCUS + SALT", "GARDEN HIGHBALL", "HARBOR FIZZ", "CITRUS RANGE"],
  },
};

const classTypes: Record<BeverageType, string[]> = {
  beer: [
    "India Pale Ale",
    "Pale Ale",
    "Stout",
    "Pilsner",
    "Lager",
    "Hazy IPA",
    "Saison",
    "Porter",
    "Wheat Beer",
    "Amber Ale",
  ],
  wine: [
    "Cabernet Sauvignon",
    "Chardonnay",
    "Pinot Noir",
    "Sauvignon Blanc",
    "Merlot",
    "Syrah",
    "Rose",
    "Riesling",
    "Zinfandel",
    "Sparkling Wine",
  ],
  spirits: [
    "Bourbon Whiskey",
    "Rye Whiskey",
    "Scotch Whisky",
    "Vodka",
    "London Dry Gin",
    "Aged Rum",
    "White Rum",
    "Tequila Blanco",
    "Reposado Tequila",
    "Mezcal",
  ],
  fortified_wine: ["Ruby Port", "Tawny Port", "Sherry", "Vermouth", "Madeira"],
  rtd: ["Canned Cocktail", "Vodka Soda", "Malt Beverage", "Wine Cocktail", "Hard Seltzer"],
};

const producerCities: Array<[string, string, string, string]> = [
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
];

const nonCompliantCases = [
  "T1",
  "T1",
  "T2",
  "T2",
  "T3",
  "T3",
  "T4",
  "T5",
  "T6",
  "C1",
  "C1",
  "C2",
  "C2",
  "C3",
  "C3",
  "B1",
  "B1",
  "B2",
  "B2",
  "B3",
  "B3",
  "B4",
  "B4",
  "S1",
  "S1",
  "S2",
  "S2",
  "S3",
  "X2",
  "X3",
];

const degradationPlan = [
  ["perspective:5deg"],
  ["perspective:10deg"],
  ["perspective:15deg"],
  ["perspective:20deg"],
  ["perspective:25deg"],
  ["perspective:-8deg"],
  ["perspective:-14deg"],
  ["perspective:-22deg"],
  ["lowlight:0.45"],
  ["lowlight:0.55"],
  ["lowlight:0.65"],
  ["lowlight:0.70"],
  ["lowlight:0.50"],
  ["glare:0.35"],
  ["glare:0.45"],
  ["glare:0.55"],
  ["glare:0.70"],
  ["occlusion:0.04"],
  ["occlusion:0.06"],
  ["occlusion:0.08"],
  ["occlusion:0.10"],
  ["curved:0.12"],
  ["curved:0.20"],
  ["curved:0.28"],
  ["perspective:10deg", "lowlight:0.6"],
  ["perspective:15deg", "glare:0.45"],
  ["lowlight:0.55", "noise:gauss:12"],
  ["glare:0.5", "occlusion:0.05"],
  ["curved:0.18", "lowlight:0.65"],
  ["perspective:-12deg", "noise:poisson"],
];

async function main(): Promise<void> {
  const args = parseArgs(process.argv.slice(2));
  const rng = new Rng(args.seed);
  const root = join(process.cwd(), args.output);
  const labelsDir = join(root, "labels");
  const truthDir = join(root, "ground-truth");

  await mkdir(labelsDir, { recursive: true });
  await mkdir(truthDir, { recursive: true });
  await removeGeneratedFiles(labelsDir, truthDir);

  const specs = buildSyntheticSpecs(args.count, rng);
  for (const spec of specs) {
    const png = await renderSyntheticPng(spec);
    await writeLabelAndTruth(labelsDir, truthDir, spec.truth, png);
  }

  const degradeSources = pickDegradeSources(specs, args.degrade);
  for (let i = 0; i < degradeSources.length; i++) {
    const source = degradeSources[i]!;
    const degradations = degradationPlan[i % degradationPlan.length]!;
    const sourcePath = join(labelsDir, `${source.truth.id}.png`);
    const sourceBuffer = await sharp(sourcePath).png().toBuffer();
    const degradedBuffer = await applyDegradations(sourceBuffer, degradations, rng);
    const degId = source.truth.id.replace(/^syn-/, "deg-").replace(/-\d{4}$/, `-${pad(i + 1)}`);
    const degTruth: GroundTruth = {
      ...source.truth,
      id: degId,
      source: "degraded",
      image: toRepoPath(join(labelsDir, `${degId}.png`)),
      degradations,
      notes: `${source.truth.notes} Degraded variant of ${source.truth.id}: ${degradations.join(", ")}.`,
    };
    await writeLabelAndTruth(labelsDir, truthDir, degTruth, degradedBuffer);
  }

  console.log(
    `[gen:corpus] wrote ${specs.length} synthetic + ${degradeSources.length} degraded labels to ${args.output}`,
  );
}

function buildSyntheticSpecs(count: number, rng: Rng): SyntheticSpec[] {
  const beverages = shuffle(
    distribute<BeverageType>(
      [
        ["beer", 0.35],
        ["wine", 0.3],
        ["spirits", 0.25],
        ["fortified_wine", 0.1],
      ],
      count,
    ),
    rng,
  );
  const faces = shuffle(
    distribute<LabelFace>(
      [
        ["front", 0.6],
        ["back", 0.3],
        ["neck", 0.1],
      ],
      count,
    ),
    rng,
  );
  const patterns = shuffle(
    distribute<BrandPattern>(
      [
        ["single", 0.35],
        ["multi", 0.3],
        ["punctuation", 0.2],
        ["stylized", 0.15],
      ],
      count,
    ),
    rng,
  );
  const containerSizes = shuffle(
    [
      ...Array.from({ length: Math.round(count * 0.25) }, (_, i) =>
        [50, 100, 187, 200, 237][i % 5]!,
      ),
      ...Array.from({ length: count - Math.round(count * 0.25) }, (_, i) =>
        [355, 375, 500, 700, 750, 1000][i % 6]!,
      ),
    ],
    rng,
  );
  const warningCases = buildWarningCasePlan(count);
  const counters: Record<string, number> = {};

  return Array.from({ length: count }, (_, i) => {
    const beverage = beverages[i]!;
    const labelFace = faces[i]!;
    const brandPattern = patterns[i]!;
    const caseId = warningCases[i]!;
    const containerSizeMl = containerSizes[i]!;
    counters[beverage] = (counters[beverage] ?? 0) + 1;
    const id = `syn-${beverage}-${pad(counters[beverage]!)}`;
    const classType = choice(classTypes[beverage], rng);
    const brandName = choice(brands[beverage][brandPattern], rng);
    const producer = makeProducer(brandName, i);
    const netContents = netContentsFor(containerSizeMl);
    const abv = abvFor(beverage, rng);
    const classCategory = classCategoryFor(beverage);
    const warning = makeWarning(caseId, containerSizeMl);
    const truth: GroundTruth = {
      id,
      source: "synthetic",
      image: `test-data/labels/${id}.png`,
      degradations: [],
      beverage_type: beverage,
      label_face: labelFace,
      container_size_ml: containerSizeMl,
      fields: {
        brand_name: brandName,
        class_type: classType,
        class_category: classCategory,
        abv_percent: abv,
        net_contents: netContents,
        producer,
        country_of_origin: "USA",
        government_warning: warningTruthFor(caseId),
      },
      gov_warning_case: caseId,
      notes: notesFor(caseId, labelFace, brandPattern, containerSizeMl),
    };
    return {
      truth,
      warning,
      palette: palettes[i % palettes.length]!,
      brandPattern,
      layoutVariant: i % 6,
    };
  });
}

function buildWarningCasePlan(count: number): (string | null)[] {
  if (count === DEFAULT_SYNTHETIC_COUNT) {
    return [
      ...Array.from({ length: 20 }, () => null),
      ...nonCompliantCases,
      ...Array.from({ length: 10 }, () => "X1"),
    ];
  }
  const compliant = Math.max(1, Math.round(count * 0.34));
  const missing = Math.max(1, Math.round(count * 0.16));
  const nonCompliant = Math.max(0, count - compliant - missing);
  return [
    ...Array.from({ length: compliant }, () => null),
    ...Array.from({ length: nonCompliant }, (_, i) => nonCompliantCases[i % nonCompliantCases.length]!),
    ...Array.from({ length: missing }, () => "X1"),
  ];
}

function pickDegradeSources(specs: SyntheticSpec[], count: number): SyntheticSpec[] {
  const compliant = specs.filter((spec) => spec.truth.gov_warning_case === null).slice(0, 10);
  const nonCompliant = specs
    .filter((spec) => spec.truth.gov_warning_case !== null && spec.truth.gov_warning_case !== "X1")
    .slice(0, 10);
  const missing = specs.filter((spec) => spec.truth.gov_warning_case === "X1").slice(0, 10);
  const planned = [...compliant, ...nonCompliant, ...missing];
  if (count <= planned.length) return planned.slice(0, count);
  return [...planned, ...specs.filter((spec) => !planned.includes(spec)).slice(0, count - planned.length)];
}

async function renderSyntheticPng(spec: SyntheticSpec): Promise<Buffer> {
  const svg = renderSvg(spec);
  return sharp(Buffer.from(svg))
    .png({
      compressionLevel: 9,
      adaptiveFiltering: true,
      palette: true,
      colours: 256,
    })
    .toBuffer();
}

function renderSvg(spec: SyntheticSpec): string {
  const { truth, palette, warning } = spec;
  const brandSize =
    truth.label_face === "neck"
      ? 46
      : spec.brandPattern === "stylized"
        ? 64
        : spec.layoutVariant % 2 === 0
          ? 72
          : 58;
  const classSize = spec.layoutVariant % 3 === 0 ? 32 : 28;
  const panelX = truth.label_face === "neck" ? 180 : 90;
  const panelY = truth.label_face === "neck" ? 70 : 55;
  const panelW = truth.label_face === "neck" ? 540 : 720;
  const panelH = truth.label_face === "neck" ? 1060 : 1090;
  const fieldY = truth.label_face === "neck" ? 350 : 360;
  const warningY = warning.crowded ? 820 : truth.label_face === "neck" ? 760 : 790;
  const warningCharsPerLine = Math.max(
    28,
    Math.floor((panelW - 125) / (warning.bodyFontSize * 0.64)),
  );
  const bodyLines = wrapText(
    warning.bodyText,
    warning.foreignOnly ? Math.min(46, warningCharsPerLine) : warningCharsPerLine,
  );
  const brandLines = wrapText(truth.fields.brand_name, truth.label_face === "neck" ? 12 : 16);
  const producer = truth.fields.producer;
  const net = truth.fields.net_contents;
  const netText = `${net.value} ${unitLabel(net.unit)}`;
  const accentBand = spec.layoutVariant % 2 === 0 ? "horizontal" : "vertical";
  const decorations = renderDecorations(spec, panelX, panelY, panelW, panelH, accentBand);

  const warningBlock = warning.visible
    ? renderWarningBlock(warning, palette, panelX + 46, warningY, panelW - 92, bodyLines)
    : "";

  const brandText = brandLines
    .map((line, idx) =>
      text(panelX + panelW / 2, 185 + idx * (brandSize * 0.92), line, {
        size: brandSize,
        weight: 800,
        fill: palette.ink,
        anchor: "middle",
        family: "Georgia, 'Times New Roman', serif",
      }),
    )
    .join("\n");

  return `<?xml version="1.0" encoding="UTF-8"?>
<svg xmlns="http://www.w3.org/2000/svg" width="${CANVAS.width}" height="${CANVAS.height}" viewBox="0 0 ${CANVAS.width} ${CANVAS.height}">
  <defs>
    <linearGradient id="softPanel" x1="0" x2="1" y1="0" y2="1">
      <stop offset="0%" stop-color="${palette.panel}"/>
      <stop offset="100%" stop-color="${tint(palette.panel, -8)}"/>
    </linearGradient>
  </defs>
  <rect width="900" height="1200" fill="${palette.background}"/>
  <rect x="${panelX}" y="${panelY}" width="${panelW}" height="${panelH}" rx="26" fill="url(#softPanel)" stroke="${palette.border}" stroke-width="5"/>
  <rect x="${panelX + 12}" y="${panelY + 12}" width="${panelW - 24}" height="${panelH - 24}" rx="18" fill="none" stroke="${palette.accent}" stroke-width="2"/>
  ${decorations}
  ${text(panelX + panelW / 2, 112, labelFaceTitle(truth.label_face), {
    size: 18,
    weight: 700,
    fill: palette.accent,
    anchor: "middle",
    letterSpacing: 2,
  })}
  ${brandText}
  ${text(panelX + panelW / 2, 288, truth.fields.class_type, {
    size: classSize,
    weight: 650,
    fill: palette.accent,
    anchor: "middle",
  })}
  ${text(panelX + panelW / 2, 330, `${truth.fields.abv_percent.toFixed(1)}% ALC/VOL   ${netText}`, {
    size: 25,
    weight: 700,
    fill: palette.ink,
    anchor: "middle",
  })}
  ${fieldLine(panelX + 56, fieldY, "Produced by", producer.name ?? "", palette)}
  ${fieldLine(panelX + 56, fieldY + 42, "Address", `${producer.street}, ${producer.city}, ${producer.state} ${producer.postal_code}`, palette)}
  ${fieldLine(panelX + 56, fieldY + 84, "Country of Origin", truth.fields.country_of_origin, palette)}
  ${fieldLine(panelX + 56, fieldY + 126, "Container", `${truth.container_size_ml} ml`, palette)}
  ${renderSmallPrint(spec, panelX + 56, fieldY + 184)}
  ${warningBlock}
  ${text(panelX + panelW / 2, panelY + panelH - 42, "TTB TEST CORPUS - FAUX BRAND - NOT FOR SALE", {
    size: 16,
    weight: 700,
    fill: palette.muted,
    anchor: "middle",
    letterSpacing: 1,
  })}
</svg>`;
}

function renderDecorations(
  spec: SyntheticSpec,
  x: number,
  y: number,
  w: number,
  h: number,
  band: "horizontal" | "vertical",
): string {
  const p = spec.palette;
  const seal =
    spec.layoutVariant % 3 === 0
      ? `<circle cx="${x + w - 110}" cy="${y + 152}" r="55" fill="none" stroke="${p.accent2}" stroke-width="5"/>
         <circle cx="${x + w - 110}" cy="${y + 152}" r="39" fill="none" stroke="${p.accent2}" stroke-width="2"/>
         ${text(x + w - 110, y + 158, spec.truth.fields.class_category.toUpperCase(), {
           size: 13,
           weight: 800,
           fill: p.accent2,
           anchor: "middle",
         })}`
      : "";
  const stripe =
    band === "horizontal"
      ? `<rect x="${x}" y="${y + 232}" width="${w}" height="10" fill="${p.accent}" opacity="0.18"/>
         <rect x="${x}" y="${y + 248}" width="${w}" height="4" fill="${p.accent2}" opacity="0.18"/>`
      : `<rect x="${x + 32}" y="${y}" width="18" height="${h}" fill="${p.accent}" opacity="0.85"/>
         <rect x="${x + w - 50}" y="${y}" width="10" height="${h}" fill="${p.accent2}" opacity="0.65"/>`;
  return `${stripe}\n${seal}`;
}

function renderSmallPrint(spec: SyntheticSpec, x: number, y: number): string {
  const p = spec.palette;
  const lines = [
    "Contains alcohol. Please enjoy responsibly.",
    "Government sample label generated for automated verifier testing.",
    spec.truth.beverage_type === "wine"
      ? "Estate bottled from selected lots."
      : spec.truth.beverage_type === "beer"
        ? "Brewed and packaged by the named producer."
        : "Distilled, blended, or bottled by the named producer.",
  ];
  return lines
    .map((line, idx) =>
      text(x, y + idx * 28, line, {
        size: 19,
        weight: 450,
        fill: p.muted,
        anchor: "start",
      }),
    )
    .join("\n");
}

function renderWarningBlock(
  warning: RenderedWarning,
  palette: Palette,
  x: number,
  y: number,
  width: number,
  bodyLines: string[],
): string {
  if (warning.arc) {
    return renderArcWarning(warning, palette, x, y, width);
  }
  const lineGap = Math.round(warning.bodyFontSize * 1.24);
  const height =
    warning.prefixFontSize * 2 +
    22 +
    Math.max(0, bodyLines.length - 1) * lineGap +
    warning.bodyFontSize +
    (warning.crowded ? 2 : 12);
  const bg = warning.textured ? "#a87b4d" : palette.warningBg;
  const texture = warning.textured
    ? `<rect x="${x}" y="${y - warning.prefixFontSize}" width="${width}" height="${height}" fill="url(#kraft)" opacity="0.25"/>`
    : "";
  const body = bodyLines
    .map((line, idx) =>
      text(x + 16, y + warning.prefixFontSize + 10 + idx * lineGap, line, {
        size: warning.bodyFontSize,
        weight: warning.bodyWeight,
        fill: palette.ink,
        anchor: "start",
      }),
    )
    .join("\n");

  return `
  <defs>
    <filter id="warningTexture">
      <feTurbulence type="fractalNoise" baseFrequency="0.08" numOctaves="3"/>
      <feColorMatrix type="saturate" values="0.25"/>
      <feComponentTransfer><feFuncA type="table" tableValues="0.15 0.45"/></feComponentTransfer>
    </filter>
  </defs>
  <rect x="${x}" y="${y - warning.prefixFontSize - 12}" width="${width}" height="${height}" rx="${warning.crowded ? 0 : 10}" fill="${bg}" stroke="${palette.border}" stroke-width="${warning.crowded ? 0 : 2}"/>
  ${warning.textured ? `<rect x="${x}" y="${y - warning.prefixFontSize - 12}" width="${width}" height="${height}" rx="10" fill="#8d6b3e" filter="url(#warningTexture)" opacity="0.5"/>` : texture}
  ${text(x + 16, y, warning.prefixText, {
    size: warning.prefixFontSize,
    weight: warning.prefixWeight,
    fill: palette.ink,
    anchor: "start",
  })}
  ${body}`;
}

function renderArcWarning(
  warning: RenderedWarning,
  palette: Palette,
  x: number,
  y: number,
  width: number,
): string {
  const bodyLines = wrapText(warning.bodyText, 54).slice(0, 5);
  const rotatedX = x + 36;
  const rotatedY = y + 30;
  return `
  <g transform="rotate(-18 ${rotatedX + width / 2} ${rotatedY + 80})">
    <rect x="${rotatedX}" y="${rotatedY}" width="${width - 72}" height="150" rx="12" fill="${palette.warningBg}" stroke="${palette.border}" stroke-width="2" opacity="0.92"/>
    ${text(rotatedX + 14, rotatedY + 34, warning.prefixText, {
      size: 20,
      weight: warning.prefixWeight,
      fill: palette.ink,
      anchor: "start",
    })}
    ${bodyLines
      .map((line, idx) =>
        text(rotatedX + 14, rotatedY + 64 + idx * 16, line, {
          size: 13,
          weight: warning.bodyWeight,
          fill: palette.ink,
          anchor: "start",
        }),
      )
      .join("\n")}
  </g>`;
}

function fieldLine(x: number, y: number, label: string, value: string, palette: Palette): string {
  return `
    ${text(x, y, label.toUpperCase(), {
      size: 14,
      weight: 800,
      fill: palette.accent,
      anchor: "start",
      letterSpacing: 1.4,
    })}
    ${text(x, y + 25, value, {
      size: 24,
      weight: 600,
      fill: palette.ink,
      anchor: "start",
    })}`;
}

function text(
  x: number,
  y: number,
  value: string,
  opts: {
    size: number;
    weight: number;
    fill: string;
    anchor: "start" | "middle" | "end";
    family?: string;
    letterSpacing?: number;
  },
): string {
  const letterSpacing =
    opts.letterSpacing === undefined ? "" : ` letter-spacing="${opts.letterSpacing}"`;
  return `<text x="${x}" y="${y}" font-family="${opts.family ?? "Arial, Helvetica, sans-serif"}" font-size="${opts.size}" font-weight="${opts.weight}" fill="${opts.fill}" text-anchor="${opts.anchor}"${letterSpacing}>${escapeXml(value)}</text>`;
}

function makeWarning(caseId: string | null, containerSizeMl: number): RenderedWarning {
  const minPrefixSize = compliantPrefixSize(containerSizeMl);
  const base: RenderedWarning = {
    visible: true,
    prefixText: GOVERNMENT_WARNING_PREFIX,
    bodyText: GOVERNMENT_WARNING_BODY,
    prefixWeight: 700,
    bodyWeight: 400,
    prefixFontSize: minPrefixSize,
    bodyFontSize: Math.max(15, Math.min(20, Math.round(minPrefixSize * 0.55))),
    textured: false,
    crowded: false,
    arc: false,
    foreignOnly: false,
  };
  if (caseId === null) return base;
  if (caseId === "X1") return { ...base, visible: false };

  const cases = caseId.split("/");
  let out = { ...base };
  for (const c of cases) {
    out = applyWarningCase(out, c, containerSizeMl);
  }
  return out;
}

function applyWarningCase(
  warning: RenderedWarning,
  caseId: string,
  containerSizeMl: number,
): RenderedWarning {
  switch (caseId) {
    case "T1":
      return {
        ...warning,
        bodyText: warning.bodyText.replace("may cause health problems", "may cause health issues"),
      };
    case "T2":
      return {
        ...warning,
        bodyText: warning.bodyText.replace("risk of birth defects", "risk of birth defect"),
      };
    case "T3":
      return {
        ...warning,
        bodyText: warning.bodyText.replace("Surgeon General, women", "Surgeon General women"),
      };
    case "T4":
      return {
        ...warning,
        bodyText:
          "(2) Consumption of alcoholic beverages impairs your ability to drive a car or operate machinery, and may cause health problems. (1) According to the Surgeon General, women should not drink alcoholic beverages during pregnancy because of the risk of birth defects.",
      };
    case "T5":
      return {
        ...warning,
        bodyText: warning.bodyText.replace("birth defects. (2)", "birth defects; (2)"),
      };
    case "T6":
      return {
        ...warning,
        bodyText: warning.bodyText.replace(
          "According to the Surgeon General,",
          "According to the \u201cSurgeon General,\u201d",
        ),
      };
    case "C1":
      return { ...warning, prefixText: "Government Warning:" };
    case "C2":
      return { ...warning, prefixText: "government warning:" };
    case "C3":
      return { ...warning, prefixText: "GOVERNMENT Warning:" };
    case "B1":
      return { ...warning, prefixWeight: 400 };
    case "B2":
      return { ...warning, prefixWeight: 400, bodyWeight: 700 };
    case "B3":
      return { ...warning, prefixWeight: 500 };
    case "B4":
      return { ...warning, prefixWeight: 550, textured: true };
    case "S1":
      return {
        ...warning,
        prefixFontSize: Math.max(12, Math.round(compliantPrefixSize(Math.max(750, containerSizeMl)) * 0.55)),
        bodyFontSize: 17,
      };
    case "S2":
      return {
        ...warning,
        prefixFontSize: Math.max(9, Math.round(compliantPrefixSize(Math.min(200, containerSizeMl)) * 0.5)),
        bodyFontSize: 14,
      };
    case "S3":
      return { ...warning, crowded: true };
    case "X2":
      return { ...warning, arc: true, bodyFontSize: 17, prefixFontSize: 20 };
    case "X3":
      return {
        ...warning,
        foreignOnly: true,
        prefixText: "ADVERTENCIA DEL GOBIERNO:",
        bodyText:
          "Segun el Cirujano General, las mujeres no deben beber alcohol durante el embarazo. El consumo de bebidas alcoholicas afecta su capacidad para conducir y puede causar problemas de salud.",
      };
    default:
      return warning;
  }
}

function warningTruthFor(caseId: string | null): GovernmentWarningTruth {
  if (caseId === null) {
    return {
      present: true,
      text_matches_regulation: true,
      prefix_all_caps: true,
      prefix_bold: true,
      meets_size_minimum: true,
    };
  }
  if (caseId === "X1") {
    return {
      present: false,
      text_matches_regulation: false,
      prefix_all_caps: false,
      prefix_bold: false,
      meets_size_minimum: false,
    };
  }

  const cases = caseId.split("/");
  return {
    present: true,
    text_matches_regulation: !cases.some((c) => c.startsWith("T") || c === "X3"),
    prefix_all_caps: !cases.some((c) => c.startsWith("C") || c === "X3"),
    prefix_bold: !cases.some((c) => c.startsWith("B")),
    meets_size_minimum: !cases.some((c) => c === "S1" || c === "S2"),
  };
}

function notesFor(
  caseId: string | null,
  face: LabelFace,
  pattern: BrandPattern,
  containerSizeMl: number,
): string {
  const base = `${face} label, ${pattern} brand pattern, ${containerSizeMl} ml container.`;
  if (caseId === null) return `${base} Government Warning is compliant.`;
  if (caseId === "X1") return `${base} Government Warning intentionally missing.`;
  return `${base} Government Warning non-compliance case ${caseId}.`;
}

async function applyDegradations(
  input: Buffer,
  degradations: string[],
  rng: Rng,
): Promise<Buffer> {
  let pipeline = sharp(input).ensureAlpha();
  for (const degradation of degradations) {
    if (degradation.startsWith("perspective:")) {
      const deg = Number(degradation.match(/perspective:([-\d.]+)deg/)?.[1] ?? 0);
      pipeline = pipeline
        .rotate(deg, { background: "#f4f4f5" })
        .resize({ width: CANVAS.width, height: CANVAS.height, fit: "contain", background: "#f4f4f5" });
    } else if (degradation.startsWith("lowlight:")) {
      const factor = Number(degradation.split(":")[1] ?? "0.6");
      pipeline = pipeline.modulate({ brightness: factor, saturation: 0.82 });
    } else if (degradation.startsWith("glare:")) {
      const intensity = Number(degradation.split(":")[1] ?? "0.5");
      const overlay = glareOverlay(intensity, rng);
      pipeline = pipeline.composite([{ input: Buffer.from(overlay), blend: "screen" }]);
    } else if (degradation.startsWith("occlusion:")) {
      const frac = Number(degradation.split(":")[1] ?? "0.06");
      const overlay = occlusionOverlay(frac, rng);
      pipeline = pipeline.composite([{ input: Buffer.from(overlay), blend: "over" }]);
    } else if (degradation.startsWith("curved:")) {
      const bow = Number(degradation.split(":")[1] ?? "0.18");
      const width = Math.round(CANVAS.width * (1 - bow * 0.18));
      pipeline = pipeline
        .resize({ width, height: CANVAS.height, fit: "fill" })
        .extend({
          left: Math.floor((CANVAS.width - width) / 2),
          right: Math.ceil((CANVAS.width - width) / 2),
          top: 0,
          bottom: 0,
          background: "#f4f4f5",
        })
        .composite([{ input: Buffer.from(curveOverlay(bow)), blend: "multiply" }]);
    } else if (degradation.startsWith("noise:gauss:")) {
      const sigma = Number(degradation.split(":")[2] ?? "12");
      pipeline = pipeline.composite([{ input: Buffer.from(noiseOverlay(rng, sigma)), blend: "overlay" }]);
    } else if (degradation === "noise:poisson") {
      pipeline = pipeline.composite([{ input: Buffer.from(noiseOverlay(rng, 18)), blend: "overlay" }]);
    }
  }
  return pipeline
    .flatten({ background: "#f4f4f5" })
    .png({
      compressionLevel: 9,
      adaptiveFiltering: true,
      palette: true,
      colours: 256,
    })
    .toBuffer();
}

function glareOverlay(intensity: number, rng: Rng): string {
  const cx = Math.round(rng.nextBetween(250, 650));
  const cy = Math.round(rng.nextBetween(250, 900));
  const rx = Math.round(rng.nextBetween(150, 300));
  const ry = Math.round(rng.nextBetween(70, 160));
  return `<svg xmlns="http://www.w3.org/2000/svg" width="${CANVAS.width}" height="${CANVAS.height}">
    <defs>
      <radialGradient id="g">
        <stop offset="0%" stop-color="#ffffff" stop-opacity="${intensity}"/>
        <stop offset="45%" stop-color="#ffffff" stop-opacity="${intensity * 0.45}"/>
        <stop offset="100%" stop-color="#ffffff" stop-opacity="0"/>
      </radialGradient>
    </defs>
    <ellipse cx="${cx}" cy="${cy}" rx="${rx}" ry="${ry}" fill="url(#g)" transform="rotate(${rng.nextBetween(-18, 18)} ${cx} ${cy})"/>
  </svg>`;
}

function occlusionOverlay(frac: number, rng: Rng): string {
  const area = CANVAS.width * CANVAS.height * frac;
  const w = Math.round(Math.sqrt(area) * rng.nextBetween(1.2, 2.0));
  const h = Math.round(area / w);
  const x = Math.round(rng.nextBetween(120, CANVAS.width - w - 120));
  const y = Math.round(rng.nextBetween(280, CANVAS.height - h - 150));
  const color = rng.next() > 0.5 ? "#d8b28c" : "#f8fafc";
  const stroke = color === "#f8fafc" ? "#cbd5e1" : "#b88b6a";
  return `<svg xmlns="http://www.w3.org/2000/svg" width="${CANVAS.width}" height="${CANVAS.height}">
    <rect x="${x}" y="${y}" width="${w}" height="${h}" rx="22" fill="${color}" stroke="${stroke}" stroke-width="3" opacity="0.94"/>
  </svg>`;
}

function curveOverlay(bow: number): string {
  const opacity = Math.min(0.28, bow);
  return `<svg xmlns="http://www.w3.org/2000/svg" width="${CANVAS.width}" height="${CANVAS.height}">
    <defs>
      <linearGradient id="curve" x1="0" x2="1">
        <stop offset="0%" stop-color="#000000" stop-opacity="${opacity}"/>
        <stop offset="20%" stop-color="#ffffff" stop-opacity="0.1"/>
        <stop offset="50%" stop-color="#ffffff" stop-opacity="0"/>
        <stop offset="82%" stop-color="#000000" stop-opacity="${opacity * 0.85}"/>
        <stop offset="100%" stop-color="#000000" stop-opacity="${opacity}"/>
      </linearGradient>
    </defs>
    <rect width="${CANVAS.width}" height="${CANVAS.height}" fill="url(#curve)"/>
  </svg>`;
}

function noiseOverlay(rng: Rng, sigma: number): string {
  const dots = Math.round(400 + sigma * 18);
  const circles = Array.from({ length: dots }, () => {
    const x = Math.round(rng.nextBetween(0, CANVAS.width));
    const y = Math.round(rng.nextBetween(0, CANVAS.height));
    const r = rng.nextBetween(0.4, 1.6).toFixed(2);
    const o = rng.nextBetween(0.04, Math.min(0.18, sigma / 80)).toFixed(3);
    const fill = rng.next() > 0.5 ? "#000000" : "#ffffff";
    return `<circle cx="${x}" cy="${y}" r="${r}" fill="${fill}" opacity="${o}"/>`;
  }).join("");
  return `<svg xmlns="http://www.w3.org/2000/svg" width="${CANVAS.width}" height="${CANVAS.height}">${circles}</svg>`;
}

async function writeLabelAndTruth(
  labelsDir: string,
  truthDir: string,
  truth: GroundTruth,
  imageBuffer: Buffer,
): Promise<void> {
  const imagePath = join(labelsDir, `${truth.id}.png`);
  const groundTruthPath = join(truthDir, `${truth.id}.json`);
  const normalizedTruth = {
    ...truth,
    image: toRepoPath(imagePath),
  };
  await writeFile(imagePath, imageBuffer);
  await writeFile(groundTruthPath, `${JSON.stringify(normalizedTruth, null, 2)}\n`);
}

async function removeGeneratedFiles(labelsDir: string, truthDir: string): Promise<void> {
  await removeMatching(labelsDir, /^(syn|deg)-.*\.(png|jpg|jpeg|webp)$/i);
  await removeMatching(truthDir, /^(syn|deg)-.*\.json$/i);
}

async function removeMatching(dir: string, pattern: RegExp): Promise<void> {
  let entries: string[] = [];
  try {
    entries = await readdir(dir);
  } catch {
    return;
  }
  for (const entry of entries) {
    if (pattern.test(entry)) {
      await rm(join(dir, entry), { force: true });
    }
  }
}

function makeProducer(brandName: string, i: number): ProducerAddress {
  const [street, city, state, postal] = producerCities[i % producerCities.length]!;
  const cleaned = brandName
    .replace(/\b(THE|THEE)\b/gi, "")
    .replace(/[^A-Za-z0-9 ]+/g, "")
    .trim();
  return {
    name: `${cleaned} Beverage Co.`,
    street,
    city,
    state,
    postal_code: postal,
    country: "USA",
  };
}

function netContentsFor(containerSizeMl: number): NetContents {
  if (containerSizeMl === 355) return { value: 12, unit: "fl_oz" };
  if (containerSizeMl === 375) return { value: 375, unit: "ml" };
  if (containerSizeMl === 500) return { value: 500, unit: "ml" };
  if (containerSizeMl === 700) return { value: 70, unit: "cl" };
  if (containerSizeMl === 750) return { value: 750, unit: "ml" };
  if (containerSizeMl === 1000) return { value: 1, unit: "L" };
  return { value: containerSizeMl, unit: "ml" };
}

function abvFor(beverage: BeverageType, rng: Rng): number {
  const range: Record<BeverageType, [number, number]> = {
    beer: [3.5, 8.0],
    wine: [11.0, 14.5],
    spirits: [35.0, 55.0],
    fortified_wine: [17.0, 22.0],
    rtd: [4.0, 9.0],
  };
  const [lo, hi] = range[beverage];
  return Math.round(rng.nextBetween(lo, hi) * 10) / 10;
}

function classCategoryFor(beverage: BeverageType): ClassCategory {
  if (beverage === "spirits") return "distilled_spirits";
  if (beverage === "fortified_wine" || beverage === "rtd") return "fortified_wine";
  return beverage;
}

function compliantPrefixSize(containerSizeMl: number): number {
  const longEdgePx = CANVAS.height;
  const labelHeightMm = labelHeightMmFor(containerSizeMl);
  const pxPerMm = longEdgePx / labelHeightMm;
  const minMm = containerSizeMl <= 237 ? 1 : 2;
  return Math.min(46, Math.max(24, Math.ceil((minMm * pxPerMm) / 0.72 + 5)));
}

function labelHeightMmFor(containerSizeMl: number): number {
  if (containerSizeMl <= 50) return 30;
  if (containerSizeMl <= 200) return 60;
  if (containerSizeMl <= 375) return 80;
  if (containerSizeMl <= 750) return 100;
  if (containerSizeMl <= 1000) return 120;
  return 140;
}

function labelFaceTitle(face: LabelFace): string {
  if (face === "front") return "PRIMARY BRAND LABEL";
  if (face === "back") return "BACK LABEL";
  return "NECK / SIDE LABEL";
}

function unitLabel(unit: NetUnit): string {
  if (unit === "fl_oz") return "FL OZ";
  return unit;
}

function wrapText(input: string, maxChars: number): string[] {
  const words = input.split(/\s+/);
  const lines: string[] = [];
  let current = "";
  for (const word of words) {
    const next = current ? `${current} ${word}` : word;
    if (next.length > maxChars && current) {
      lines.push(current);
      current = word;
    } else {
      current = next;
    }
  }
  if (current) lines.push(current);
  return lines;
}

function distribute<T>(weighted: [T, number][], count: number): T[] {
  const exact = weighted.map(([value, weight]) => ({ value, exact: weight * count }));
  const floors = exact.map((item) => ({ value: item.value, count: Math.floor(item.exact), rem: item.exact % 1 }));
  let remaining = count - floors.reduce((sum, item) => sum + item.count, 0);
  floors.sort((a, b) => b.rem - a.rem);
  for (let i = 0; i < remaining; i++) floors[i % floors.length]!.count += 1;
  const out: T[] = [];
  for (const item of floors) out.push(...Array.from({ length: item.count }, () => item.value));
  return out.slice(0, count);
}

function shuffle<T>(items: T[], rng: Rng): T[] {
  const out = items.slice();
  for (let i = out.length - 1; i > 0; i--) {
    const j = Math.floor(rng.next() * (i + 1));
    [out[i], out[j]] = [out[j]!, out[i]!];
  }
  return out;
}

function choice<T>(items: T[], rng: Rng): T {
  return items[Math.floor(rng.next() * items.length)]!;
}

function tint(hex: string, amount: number): string {
  const clean = hex.replace("#", "");
  const r = clamp(parseInt(clean.slice(0, 2), 16) + amount, 0, 255);
  const g = clamp(parseInt(clean.slice(2, 4), 16) + amount, 0, 255);
  const b = clamp(parseInt(clean.slice(4, 6), 16) + amount, 0, 255);
  return `#${toHex(r)}${toHex(g)}${toHex(b)}`;
}

function toHex(n: number): string {
  return Math.round(n).toString(16).padStart(2, "0");
}

function clamp(n: number, lo: number, hi: number): number {
  return Math.max(lo, Math.min(hi, n));
}

function escapeXml(input: string): string {
  return input
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

function pad(n: number): string {
  return String(n).padStart(4, "0");
}

function toRepoPath(absPath: string): string {
  return relative(process.cwd(), absPath).replace(/\\/g, "/");
}

function parseArgs(argv: string[]): Args {
  const args: Args = {
    seed: DEFAULT_SEED,
    count: DEFAULT_SYNTHETIC_COUNT,
    degrade: DEFAULT_DEGRADED_COUNT,
    output: DEFAULT_OUTPUT,
  };
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i]!;
    if (arg === "--seed") args.seed = Number(argv[++i] ?? args.seed);
    else if (arg === "--count") args.count = Number(argv[++i] ?? args.count);
    else if (arg === "--degrade") args.degrade = Number(argv[++i] ?? args.degrade);
    else if (arg === "--output") args.output = argv[++i] ?? args.output;
  }
  if (!Number.isInteger(args.seed)) throw new Error("--seed must be an integer");
  if (!Number.isInteger(args.count) || args.count < 1) throw new Error("--count must be a positive integer");
  if (!Number.isInteger(args.degrade) || args.degrade < 0) throw new Error("--degrade must be a non-negative integer");
  return args;
}

class Rng {
  private state: number;

  constructor(seed: number) {
    this.state = seed >>> 0;
  }

  next(): number {
    this.state = (1664525 * this.state + 1013904223) >>> 0;
    return this.state / 0x100000000;
  }

  nextBetween(min: number, max: number): number {
    return min + this.next() * (max - min);
  }
}

main().catch((err: unknown) => {
  console.error(err);
  process.exit(1);
});
