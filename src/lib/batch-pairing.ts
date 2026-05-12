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
]);

const APPLICATION_EXT = new Set(["pdf", "json", "csv", "md", "txt"]);
const IMAGE_EXT = new Set(["jpg", "jpeg", "png", "webp", "heic", "heif"]);

export type FileKind = "image" | "application" | "other";

/**
 * Lowercase basename with the extension stripped. `"ACME-Vodka.JPG"` →
 * `"acme-vodka"`. Strips a trailing `-front` / `-back` / `-label`
 * suffix optionally — TTB reviewers often name multi-face uploads
 * with these tags and there's only one application per COLA number.
 * Callers who want strict matching can pass `{ stripFaceTag: false }`.
 */
export function stem(
  filename: string,
  opts: { stripFaceTag?: boolean } = {},
): string {
  const stripFaceTag = opts.stripFaceTag ?? false;
  const base = filename.split(/[\\/]/).pop() ?? filename;
  const dot = base.lastIndexOf(".");
  let s = (dot > 0 ? base.slice(0, dot) : base).toLowerCase();
  if (stripFaceTag) {
    s = s.replace(/[-_](front|back|label|side|neck|primary)$/, "");
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
    appsByRelaxed.set(stem(app.name, { stripFaceTag: true }), app);
  }
  const usedApps = new Set<File>();

  // Pass 1: strict.
  const unpairedAfterStrict: File[] = [];
  for (const img of images) {
    const s = stem(img.name);
    const hit = appsByStrict.get(s);
    if (hit && !usedApps.has(hit)) {
      paired.push({ imageFile: img, applicationFile: hit, stem: s });
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
      paired.push({ imageFile: img, applicationFile: hit, stem: s });
      usedApps.add(hit);
    } else {
      unpairedImages.push(img);
    }
  }

  const unpairedApplications = applications.filter((a) => !usedApps.has(a));
  return { paired, unpairedImages, unpairedApplications, ignored };
}

export interface PairingSummary {
  mode: "manifest" | "auto-stem";
  totalItems: number;
  pairedCount: number;
  pairs: Array<{ image: string; application: string; stem: string }>;
  unpairedImages: string[];
  unpairedApplications: string[];
  ignored: string[];
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
    })),
    unpairedImages: pairing.unpairedImages.map((f) => f.name),
    unpairedApplications: pairing.unpairedApplications.map((f) => f.name),
    ignored: pairing.ignored.map((f) => f.name),
  };
}
