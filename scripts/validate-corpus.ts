import { access, readdir, readFile, stat } from "node:fs/promises";
import { join, basename, extname, relative } from "node:path";
import sharp from "sharp";
import { z } from "zod";

const ROOT = process.cwd();
// Default to the canonical superset corpus. v1 `test-data/` was
// archived to `legacy/test-data-v1/` on 2026-05-13 (Agent B audit:
// same filenames as v2 with different image bytes = a footgun
// vector for path-substitution mistakes).
const DEFAULT_OUTPUT = "test-data-combined";

const SourceSchema = z.enum(["synthetic", "degraded", "real"]);
const BeverageTypeSchema = z.enum([
  "beer",
  "wine",
  "spirits",
  "fortified_wine",
  "rtd",
]);
const ClassCategorySchema = z.enum([
  "beer",
  "wine",
  "distilled_spirits",
  "fortified_wine",
]);
const LabelFaceSchema = z.enum(["front", "back", "neck"]);
const NetContentsSchema = z.object({
  value: z.number().positive(),
  unit: z.enum(["fl_oz", "ml", "L", "cl"]),
});
const ProducerSchema = z.object({
  name: z.string().nullable(),
  street: z.string().nullable(),
  city: z.string().nullable(),
  state: z.string().nullable(),
  postal_code: z.string().nullable(),
  country: z.string().nullable(),
});
const GovernmentWarningTruthSchema = z.object({
  present: z.boolean(),
  text_matches_regulation: z.boolean(),
  prefix_all_caps: z.boolean(),
  prefix_bold: z.boolean(),
  meets_size_minimum: z.boolean(),
});

export const GroundTruthSchema = z.object({
  id: z.string().regex(/^(syn|deg|real)-[a-z_]+-\d{4}$/),
  source: SourceSchema,
  image: z.string().min(1),
  degradations: z.array(z.string()).optional(),
  beverage_type: BeverageTypeSchema,
  label_face: LabelFaceSchema,
  container_size_ml: z.number().positive(),
  fields: z.object({
    brand_name: z.string().min(1),
    class_type: z.string().min(1),
    class_category: ClassCategorySchema,
    abv_percent: z.number().min(0).max(100),
    net_contents: NetContentsSchema,
    producer: ProducerSchema,
    country_of_origin: z.string().min(2),
    government_warning: GovernmentWarningTruthSchema,
  }),
  gov_warning_case: z.string().nullable(),
  notes: z.string().min(1),
});
export type GroundTruth = z.infer<typeof GroundTruthSchema>;

interface Args {
  output: string;
  strict: boolean;
}

interface ValidationIssue {
  severity: "error" | "warning";
  message: string;
}

async function main(): Promise<void> {
  const args = parseArgs(process.argv.slice(2));
  const root = join(ROOT, args.output);
  const labelsDir = join(root, "labels");
  const truthDir = join(root, "ground-truth");
  const issues: ValidationIssue[] = [];

  const truthFiles = await listFiles(truthDir, ".json");
  const labelFiles = await listFiles(labelsDir, [".png", ".jpg", ".jpeg", ".webp"]);

  const labelsByStem = new Map(labelFiles.map((file) => [stem(file), file]));
  const truthById = new Map<string, GroundTruth>();

  for (const file of truthFiles) {
    const fullPath = join(truthDir, file);
    let parsed: unknown;
    try {
      parsed = JSON.parse(await readFile(fullPath, "utf8"));
    } catch (err) {
      issues.push({
        severity: "error",
        message: `${file}: JSON parse failed: ${(err as Error).message}`,
      });
      continue;
    }

    const result = GroundTruthSchema.safeParse(parsed);
    if (!result.success) {
      issues.push({
        severity: "error",
        message: `${file}: schema failed: ${result.error.issues
          .map((issue) => `${issue.path.join(".")}: ${issue.message}`)
          .join("; ")}`,
      });
      continue;
    }

    const truth = result.data;
    if (truthById.has(truth.id)) {
      issues.push({ severity: "error", message: `${file}: duplicate id ${truth.id}` });
    }
    truthById.set(truth.id, truth);

    if (stem(file) !== truth.id) {
      issues.push({
        severity: "error",
        message: `${file}: basename must match id ${truth.id}`,
      });
    }

    const expectedImageStem = stem(truth.image);
    if (expectedImageStem !== truth.id) {
      issues.push({
        severity: "error",
        message: `${file}: image path basename ${expectedImageStem} does not match id`,
      });
    }

    const imageFile = labelsByStem.get(truth.id);
    if (!imageFile) {
      issues.push({ severity: "error", message: `${file}: missing matching label image` });
    } else {
      const repoRelative = relative(ROOT, join(labelsDir, imageFile)).replace(/\\/g, "/");
      if (repoRelative !== truth.image) {
        issues.push({
          severity: "error",
          message: `${file}: image path is ${truth.image}, expected ${repoRelative}`,
        });
      }
      await validateImage(join(labelsDir, imageFile), truth, issues);
    }

    validateWarningFlags(truth, issues);
  }

  for (const file of labelFiles) {
    const id = stem(file);
    if (!truthById.has(id)) {
      issues.push({ severity: "error", message: `${file}: missing matching ground truth` });
    }
  }

  validateDistribution(Array.from(truthById.values()), issues, args.strict);

  const errors = issues.filter((issue) => issue.severity === "error");
  const warnings = issues.filter((issue) => issue.severity === "warning");

  console.log(`[validate:corpus] labels=${labelFiles.length} groundTruth=${truthFiles.length}`);
  for (const warning of warnings) console.warn(`[warn] ${warning.message}`);
  for (const error of errors) console.error(`[error] ${error.message}`);

  if (errors.length > 0) {
    console.error(`[validate:corpus] failed with ${errors.length} error(s).`);
    process.exit(1);
  }
  console.log(`[validate:corpus] ok (${warnings.length} warning(s)).`);
}

async function validateImage(
  path: string,
  truth: GroundTruth,
  issues: ValidationIssue[],
): Promise<void> {
  try {
    await access(path);
    const info = await sharp(path).metadata();
    if (!info.width || !info.height) {
      issues.push({ severity: "error", message: `${truth.id}: image dimensions unavailable` });
    }
    if ((info.width ?? 0) > 1600 || (info.height ?? 0) > 1600) {
      issues.push({
        severity: truth.source === "real" ? "warning" : "error",
        message: `${truth.id}: long edge exceeds 1600px (${info.width}x${info.height})`,
      });
    }
    const size = (await stat(path)).size;
    if (size > 500 * 1024) {
      issues.push({
        severity: "warning",
        message: `${truth.id}: image is ${(size / 1024).toFixed(0)}KB; target is under 500KB`,
      });
    }
  } catch (err) {
    issues.push({
      severity: "error",
      message: `${truth.id}: cannot read image: ${(err as Error).message}`,
    });
  }
}

function validateWarningFlags(truth: GroundTruth, issues: ValidationIssue[]): void {
  const warning = truth.fields.government_warning;
  if (truth.gov_warning_case === null) {
    const ok =
      warning.present &&
      warning.text_matches_regulation &&
      warning.prefix_all_caps &&
      warning.prefix_bold &&
      warning.meets_size_minimum;
    if (!ok) {
      issues.push({
        severity: "error",
        message: `${truth.id}: compliant case has a failing Government Warning flag`,
      });
    }
  }

  if (truth.gov_warning_case === "X1" && warning.present) {
    issues.push({
      severity: "error",
      message: `${truth.id}: X1 missing-warning case must set present=false`,
    });
  }

  if (truth.source === "degraded" && (!truth.degradations || truth.degradations.length === 0)) {
    issues.push({
      severity: "error",
      message: `${truth.id}: degraded source must list at least one degradation`,
    });
  }

  if (truth.source === "synthetic" && truth.degradations && truth.degradations.length > 0) {
    issues.push({
      severity: "error",
      message: `${truth.id}: synthetic source should have empty degradations`,
    });
  }
}

function validateDistribution(
  truths: GroundTruth[],
  issues: ValidationIssue[],
  strict: boolean,
): void {
  const bySource = countBy(truths, (truth) => truth.source);
  const warningBuckets = {
    compliant: truths.filter((truth) => truth.gov_warning_case === null).length,
    nonCompliant: truths.filter(
      (truth) => truth.gov_warning_case !== null && truth.gov_warning_case !== "X1",
    ).length,
    missing: truths.filter((truth) => truth.gov_warning_case === "X1").length,
  };
  const byCase = countBy(
    truths.filter((truth) => truth.gov_warning_case !== null),
    (truth) => truth.gov_warning_case ?? "null",
  );

  console.log(`[validate:corpus] source=${formatCounts(bySource)}`);
  console.log(`[validate:corpus] warning=${formatCounts(warningBuckets)}`);
  console.log(`[validate:corpus] govCases=${formatCounts(byCase)}`);

  const expectedGenerated =
    (bySource.synthetic ?? 0) === 60 && (bySource.degraded ?? 0) === 30;
  if (!expectedGenerated) {
    issues.push({
      severity: strict ? "error" : "warning",
      message: `expected generated corpus 60 synthetic + 30 degraded; got ${formatCounts(bySource)}`,
    });
  }

  const hasFullCorpus =
    truths.length === 100 &&
    (bySource.synthetic ?? 0) === 60 &&
    (bySource.degraded ?? 0) === 30 &&
    (bySource.real ?? 0) === 10;
  if (!hasFullCorpus) {
    issues.push({
      severity: strict ? "error" : "warning",
      message: `full 100-label target not met yet; got ${truths.length} label(s)`,
    });
  }

  const generated = truths.filter((truth) => truth.source !== "real");
  if (generated.length >= 90) {
    const generatedBuckets = {
      compliant: generated.filter((truth) => truth.gov_warning_case === null).length,
      nonCompliant: generated.filter(
        (truth) => truth.gov_warning_case !== null && truth.gov_warning_case !== "X1",
      ).length,
      missing: generated.filter((truth) => truth.gov_warning_case === "X1").length,
    };
    if (
      generatedBuckets.compliant !== 30 ||
      generatedBuckets.nonCompliant !== 40 ||
      generatedBuckets.missing !== 20
    ) {
      issues.push({
        severity: "error",
        message: `generated warning split must be 30/40/20 before real labels; got ${formatCounts(
          generatedBuckets,
        )}`,
      });
    }
  }

  const requiredCases = [
    "T1",
    "T2",
    "T3",
    "T4",
    "T5",
    "T6",
    "C1",
    "C2",
    "C3",
    "B1",
    "B2",
    "B3",
    "B4",
    "S1",
    "S2",
    "S3",
    "X1",
    "X2",
    "X3",
  ];
  for (const required of requiredCases) {
    if (!truths.some((truth) => truth.gov_warning_case?.split("/").includes(required))) {
      issues.push({
        severity: "error",
        message: `missing Government Warning taxonomy case ${required}`,
      });
    }
  }
}

function parseArgs(argv: string[]): Args {
  let output = DEFAULT_OUTPUT;
  let strict = false;
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i]!;
    if (arg === "--output") output = argv[++i] ?? output;
    else if (arg === "--strict") strict = true;
  }
  return { output, strict };
}

async function listFiles(dir: string, extensions: string | string[]): Promise<string[]> {
  const wanted = Array.isArray(extensions) ? extensions : [extensions];
  try {
    const entries = await readdir(dir);
    return entries
      .filter((entry) => wanted.includes(extname(entry).toLowerCase()))
      .sort((a, b) => a.localeCompare(b));
  } catch {
    return [];
  }
}

function stem(path: string): string {
  return basename(path, extname(path));
}

function countBy<T>(items: T[], getKey: (item: T) => string): Record<string, number> {
  const out: Record<string, number> = {};
  for (const item of items) {
    const key = getKey(item);
    out[key] = (out[key] ?? 0) + 1;
  }
  return out;
}

function formatCounts(counts: Record<string, number>): string {
  return Object.entries(counts)
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([key, value]) => `${key}:${value}`)
    .join(", ");
}

main().catch((err: unknown) => {
  console.error(err);
  process.exit(1);
});
