// Filename-stem pairing for the no-manifest batch upload path.
//
// COLA reviewers commonly land in one of two scenarios:
//   A. CSV export from their COLA system with a `filename` (or
//      `cola_number`) column + a folder of images. The batch route's
//      manifest path covers this.
//   B. A folder of paired files keyed by COLA number or brand slug —
//      e.g. `123456-front.jpg` + `123456-app.pdf`, or
//      `acme-vodka.png` + `acme-vodka.json`. No manifest, just
//      filename convention. This module covers that case.
//
// Pairing rule: case- and extension-insensitive filename stem match.
// `123456-front.jpg` pairs with `123456-front.pdf` if stems match.
// One application file per image; one image per application file. If
// stems don't line up, the route surfaces a clear pairing preview and
// the operator fixes the upload before any vision call fires.

const IMAGE_MIME = new Set([
  "image/jpeg",
  "image/png",
  "image/webp",
  "image/heic",
  "image/heif",
]);

const APPLICATION_MIME = new Set([
  "application/pdf",
  "application/json",
  "text/json",
  "text/csv",
  "application/csv",
  "text/markdown",
  "text/x-markdown",
  "text/plain",
  "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
]);

const APPLICATION_EXT = new Set(["pdf", "json", "csv", "md", "txt", "docx"]);
const IMAGE_EXT = new Set(["jpg", "jpeg", "png", "webp", "heic", "heif"]);

export type FileKind = "image" | "application" | "other";

/**
 * Lowercase basename with the extension stripped. `"ACME-Vodka.JPG"` →
 * `"acme-vodka"`. Two optional normalizations are available:
 *
 *   • `stripFaceTag` — strips an image-side `-front` / `-back` /
 *     `-label` / `-side` / `-neck` / `-primary` suffix. TTB reviewers
 *     often name multi-face uploads with these tags and there's only
 *     one application per COLA number, so the relaxed pass treats
 *     `123-front.jpg` and `123-back.jpg` as both pairing with `123.pdf`.
 *
 *   • `stripAppTag` — strips an application-side `-app` /
 *     `-application` / `-cola` suffix. Reviewers also commonly tag
 *     the application document itself ("123456-app.pdf") so the
 *     relaxed pass needs to strip from both sides. Without this the
 *     documented `123-front.jpg ↔ 123-app.pdf` pairing wouldn't
 *     fire — the image's relaxed stem is `123`, the app's strict
 *     stem is `123-app`, they never match. (Hermes audit finding.)
 *
 * Callers in the strict pass leave both flags off to lock to exact
 * matches; the relaxed pass enables the right flag per file kind.
 */
export function stem(
  filename: string,
  opts: { stripFaceTag?: boolean; stripAppTag?: boolean } = {},
): string {
  const stripFaceTag = opts.stripFaceTag ?? false;
  const stripAppTag = opts.stripAppTag ?? false;
  const base = filename.split(/[\\/]/).pop() ?? filename;
  const dot = base.lastIndexOf(".");
  let s = (dot > 0 ? base.slice(0, dot) : base).toLowerCase();
  if (stripFaceTag) {
    s = s.replace(/[-_](front|back|label|side|neck|primary)$/, "");
  }
  if (stripAppTag) {
    s = s.replace(/[-_](app|application|cola|form|manifest)$/, "");
  }
  return s;
}

function extOf(filename: string): string {
  const base = filename.split(/[\\/]/).pop() ?? filename;
  const dot = base.lastIndexOf(".");
  return dot > 0 ? base.slice(dot + 1).toLowerCase() : "";
}

/**
 * Classify a File as image / application / other.
 *
 * MIME is the primary signal; falls back to extension for browsers
 * that omit MIME for some legacy types (e.g. older Firefox on .csv).
 * The "other" bucket gets surfaced to the operator as a pairing
 * warning rather than silently dropped.
 */
export function classifyFile(file: File): FileKind {
  const mime = (file.type || "").toLowerCase();
  if (IMAGE_MIME.has(mime)) return "image";
  if (APPLICATION_MIME.has(mime)) return "application";
  const ext = extOf(file.name);
  if (IMAGE_EXT.has(ext)) return "image";
  if (APPLICATION_EXT.has(ext)) return "application";
  return "other";
}

export interface PairingHit {
  imageFile: File;
  applicationFile: File;
  /** Stem both files share (after normalisation). */
  stem: string;
  /** Where the pair came from.
   *  - `"filename-strict"` / `"filename-relaxed"`: pure filename-based matches.
   *  - `"content"`: brand/class fuzzy match (`pairByContent`).
   *  - `"manifest-inline"`: a multi-row CSV/JSON file dropped alongside
   *    the images was detected as a manifest, and this image matched
   *    by the manifest's `filename` column.
   *  - `"manifest-broadcast"`: a single-product application file was
   *    broadcast to multiple images (operator confirmed all N labels
   *    are of the same product). */
  source?:
    | "filename-strict"
    | "filename-relaxed"
    | "content"
    | "manifest-inline"
    | "manifest-broadcast";
  /** Similarity score 0..1 from the content pass (only set when
   *  `source === "content"`). 1.0 = perfect brand + class match. */
  score?: number;
}

export interface PairingResult {
  /** Successful (image, application) pairs by shared stem. */
  paired: PairingHit[];
  /** Image files with no application-file partner. */
  unpairedImages: File[];
  /** Application files with no image partner. */
  unpairedApplications: File[];
  /** Files that classified as neither image nor application — surfaced
   *  as a warning so the operator notices stray files (e.g. a `.txt`
   *  README that happened to share a stem with an image). */
  ignored: File[];
}

/**
 * Pair images to application files by shared filename stem.
 *
 * Two passes:
 *   1. Strict stem match (e.g. `123456-front.jpg` ↔ `123456-front.pdf`).
 *   2. Face-tag-stripped match — `123456-front.jpg` and
 *      `123456-back.jpg` BOTH pair with `123456-app.pdf` after
 *      stripping the trailing `-front`/`-back`. This is the common
 *      TTB multi-face case where one application document covers
 *      every face of the same bottle.
 *
 * The strict pass wins where possible; the relaxed pass only fires
 * for images still unpaired after the strict pass. That way an
 * explicit `123456-front.pdf` next to `123456-back.pdf` won't get
 * collapsed onto a single PDF by accident.
 */
export function pairByFilenameStem(files: File[]): PairingResult {
  const images: File[] = [];
  const applications: File[] = [];
  const ignored: File[] = [];

  for (const f of files) {
    const kind = classifyFile(f);
    if (kind === "image") images.push(f);
    else if (kind === "application") applications.push(f);
    else ignored.push(f);
  }

  const paired: PairingHit[] = [];
  const appsByStrict = new Map<string, File>();
  const appsByRelaxed = new Map<string, File>();
  for (const app of applications) {
    appsByStrict.set(stem(app.name), app);
    // The relaxed map strips BOTH face tags AND app-side tags so an
    // application named `123-app.pdf` (image side `123-front.jpg`)
    // pairs cleanly. (Hermes audit fix.) appsByStrict still keys on
    // the unstripped stem so an explicit `123-app.pdf` next to
    // `123-app-back.jpg` won't lose its strict match.
    appsByRelaxed.set(
      stem(app.name, { stripFaceTag: true, stripAppTag: true }),
      app,
    );
  }
  const usedApps = new Set<File>();

  // Pass 1: strict.
  const unpairedAfterStrict: File[] = [];
  for (const img of images) {
    const s = stem(img.name);
    const hit = appsByStrict.get(s);
    if (hit && !usedApps.has(hit)) {
      paired.push({
        imageFile: img,
        applicationFile: hit,
        stem: s,
        source: "filename-strict",
      });
      usedApps.add(hit);
    } else {
      unpairedAfterStrict.push(img);
    }
  }

  // Pass 2: relaxed (face-tag stripped). Each remaining image asks the
  // relaxed map; an application can serve multiple images of the same
  // bottle face-stripped stem.
  const unpairedImages: File[] = [];
  for (const img of unpairedAfterStrict) {
    const s = stem(img.name, { stripFaceTag: true });
    const hit = appsByRelaxed.get(s);
    if (hit) {
      paired.push({
        imageFile: img,
        applicationFile: hit,
        stem: s,
        source: "filename-relaxed",
      });
      usedApps.add(hit);
    } else {
      unpairedImages.push(img);
    }
  }

  const unpairedApplications = applications.filter((a) => !usedApps.has(a));
  return { paired, unpairedImages, unpairedApplications, ignored };
}

export interface PairingSummary {
  mode:
    | "manifest"
    | "auto-stem"
    | "auto-stem+content"
    | "auto-inline-manifest"
    | "auto-broadcast";
  totalItems: number;
  pairedCount: number;
  pairs: Array<{
    image: string;
    application: string;
    stem: string;
    source?: PairingHit["source"];
    score?: number;
  }>;
  unpairedImages: string[];
  unpairedApplications: string[];
  ignored: string[];
  /** Manifest rows that found no matching image (only set on
   *  `auto-inline-manifest` mode). Each entry is a human-readable
   *  description of the orphaned row. */
  orphanedManifestRows?: string[];
  /** True when a single application was broadcast to multiple images
   *  (only set on `auto-broadcast` mode). The UI surfaces a banner so
   *  the reviewer can confirm or reject the broadcast. */
  broadcast?: boolean;
}

// ─── Content-based pairing fallback ─────────────────────────────────────────
//
// When filename stems can't pair an image to an application (the user
// dropped files with mismatched / random names), fall back to MATCHING
// BY CONTENT: extract brand + class from each unpaired image via the
// vision extractor, then fuzzy-match against the brand + class parsed
// from each unpaired application. Greedy assignment, highest-scoring
// pair first, above a configurable threshold.
//
// This means a reviewer can drop a folder of randomly-named files and
// the system still figures out which image belongs to which COLA app.
//
// Cost: one extraction per unpaired image. For the common case
// (filenames pair cleanly), this never fires. For the worst case
// (every filename is random), the per-image extraction cost is
// bounded by the unpaired count and runs in parallel.

/** Lightweight DeclaredFields-ish shape the content pairer reads off
 *  each application. The application parser already returns this. */
export interface ApplicationFingerprint {
  brand_name?: string | null;
  class_type?: string | null;
  abv_percent?: number | null;
}

/** The bare extractor result the content pairer asks of each image.
 *  Production wires this to a Gemini Flash Lite call; tests inject a
 *  deterministic mock. */
export interface ImageFingerprint {
  brand_name?: string | null;
  class_type?: string | null;
  abv_percent?: number | null;
}

/** Asymmetric Levenshtein-based similarity. 1.0 = identical, 0.0 =
 *  no overlap. Case- and punctuation-normalized so "Mill Creek" vs
 *  "MILL CREEK BREWING" still scores high. */
function normalizeForFuzzy(s: string): string {
  return s
    .toLowerCase()
    .normalize("NFD")
    .replace(/\p{Diacritic}/gu, "")
    .replace(/[^a-z0-9\s]/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

function levenshtein(a: string, b: string): number {
  if (a === b) return 0;
  if (!a.length) return b.length;
  if (!b.length) return a.length;
  const prev = new Array<number>(b.length + 1);
  const curr = new Array<number>(b.length + 1);
  for (let j = 0; j <= b.length; j++) prev[j] = j;
  for (let i = 1; i <= a.length; i++) {
    curr[0] = i;
    for (let j = 1; j <= b.length; j++) {
      const cost = a[i - 1] === b[j - 1] ? 0 : 1;
      curr[j] = Math.min(curr[j - 1]! + 1, prev[j]! + 1, prev[j - 1]! + cost);
    }
    for (let j = 0; j <= b.length; j++) prev[j] = curr[j]!;
  }
  return prev[b.length]!;
}

/** String similarity 0..1. Asymmetric: high if `a` is a substring of
 *  `b` (e.g. brand "Mill Creek" matches printed "Mill Creek Brewing
 *  Co."). Falls back to length-normalized Levenshtein otherwise. */
function stringSimilarity(a: string | null | undefined, b: string | null | undefined): number {
  if (!a || !b) return 0;
  const na = normalizeForFuzzy(a);
  const nb = normalizeForFuzzy(b);
  if (!na || !nb) return 0;
  if (na === nb) return 1.0;
  // Substring match: shorter inside longer scores high.
  const [shorter, longer] = na.length <= nb.length ? [na, nb] : [nb, na];
  if (shorter.length >= 3 && longer.includes(shorter)) {
    // Score by how much of the longer string the shorter covers.
    return 0.7 + 0.25 * (shorter.length / longer.length);
  }
  const dist = levenshtein(na, nb);
  const maxLen = Math.max(na.length, nb.length);
  return Math.max(0, 1 - dist / maxLen);
}

/** Compute similarity 0..1 between an image's extracted fingerprint
 *  and an application's parsed fingerprint. Weighted toward brand
 *  (most distinctive on real labels). */
export function fingerprintSimilarity(
  image: ImageFingerprint,
  app: ApplicationFingerprint,
): number {
  const brandSim = stringSimilarity(image.brand_name, app.brand_name);
  const classSim = stringSimilarity(image.class_type, app.class_type);
  // ABV is a noisy signal — within 0.5% is a "match", farther is a
  // miss. Skipped if either side is null.
  let abvSim = 0;
  let abvWeight = 0;
  if (
    image.abv_percent != null &&
    app.abv_percent != null &&
    isFinite(image.abv_percent) &&
    isFinite(app.abv_percent)
  ) {
    const delta = Math.abs(image.abv_percent - app.abv_percent);
    abvSim = delta < 0.5 ? 1 : delta < 2 ? 0.5 : 0;
    abvWeight = 0.1;
  }
  // Brand 0.65, class 0.25, abv 0.1 (when available). Renormalise so
  // missing ABV doesn't drag the score down.
  const weights = { brand: 0.65, class: 0.25, abv: abvWeight };
  const totalWeight = weights.brand + weights.class + weights.abv;
  return (
    (weights.brand * brandSim + weights.class * classSim + weights.abv * abvSim) /
    totalWeight
  );
}

export interface ContentPairingOptions {
  /** Below this similarity, don't auto-pair. Default 0.55 — high
   *  enough to avoid bad pairs on dissimilar labels, low enough to
   *  handle "Mill Creek" ↔ "Mill Creek Brewing Co." typography
   *  differences. */
  threshold?: number;
}

/**
 * Pair unpaired images to unpaired application files by CONTENT
 * similarity. Each unpaired image's fingerprint must already be
 * extracted (caller controls the extraction so it can mock in tests
 * and share the result with downstream verify calls in production).
 *
 * Greedy assignment: take the highest-scoring (image, app) cell that
 * exceeds the threshold, assign it, mark both as used, repeat.
 * Hungarian assignment would be slightly more optimal but greedy is
 * fine for the realistic batch sizes (≤ 100) and easier to reason
 * about + test.
 */
export function pairByContent(
  unpairedImages: Array<{ file: File; fingerprint: ImageFingerprint }>,
  unpairedApplications: Array<{ file: File; fingerprint: ApplicationFingerprint }>,
  opts: ContentPairingOptions = {},
): {
  paired: PairingHit[];
  remainingImages: File[];
  remainingApplications: File[];
} {
  const threshold = opts.threshold ?? 0.55;
  // Build the score matrix (image × app).
  const cells: Array<{ i: number; j: number; score: number }> = [];
  for (let i = 0; i < unpairedImages.length; i++) {
    for (let j = 0; j < unpairedApplications.length; j++) {
      const score = fingerprintSimilarity(
        unpairedImages[i]!.fingerprint,
        unpairedApplications[j]!.fingerprint,
      );
      if (score >= threshold) {
        cells.push({ i, j, score });
      }
    }
  }
  // Greedy: highest score first.
  cells.sort((a, b) => b.score - a.score);
  const usedImages = new Set<number>();
  const usedApps = new Set<number>();
  const paired: PairingHit[] = [];
  for (const cell of cells) {
    if (usedImages.has(cell.i) || usedApps.has(cell.j)) continue;
    usedImages.add(cell.i);
    usedApps.add(cell.j);
    const imageFile = unpairedImages[cell.i]!.file;
    const applicationFile = unpairedApplications[cell.j]!.file;
    paired.push({
      imageFile,
      applicationFile,
      // Stem is what they end up sharing on output for downstream
      // consumers; we use the image filename stem since that's what
      // the per-item result is keyed by everywhere else.
      stem: stem(imageFile.name),
      source: "content",
      score: cell.score,
    });
  }
  const remainingImages = unpairedImages
    .filter((_, i) => !usedImages.has(i))
    .map((x) => x.file);
  const remainingApplications = unpairedApplications
    .filter((_, j) => !usedApps.has(j))
    .map((x) => x.file);
  return { paired, remainingImages, remainingApplications };
}

export function summarize(
  pairing: PairingResult,
  mode: PairingSummary["mode"],
): PairingSummary {
  return {
    mode,
    totalItems: pairing.paired.length,
    pairedCount: pairing.paired.length,
    pairs: pairing.paired.map((p) => ({
      image: p.imageFile.name,
      application: p.applicationFile.name,
      stem: p.stem,
      ...(p.source ? { source: p.source } : {}),
      ...(p.score != null ? { score: p.score } : {}),
    })),
    unpairedImages: pairing.unpairedImages.map((f) => f.name),
    unpairedApplications: pairing.unpairedApplications.map((f) => f.name),
    ignored: pairing.ignored.map((f) => f.name),
  };
}
