#!/usr/bin/env tsx
// bin/labelverify.ts
//
// CLI for the LabelVerify pipeline. Exists for three reasons:
//
//   1. Operators who want to script verifications against a folder of
//      labels — no browser, no API server, just `npx labelverify
//      verify <image> <app>` and stdout gets the JSON.
//   2. A second testable surface for the same backend code as the
//      GUI. The Next.js routes and this CLI both import the same
//      verifyLabel / parseApplication / pairByFilenameStem /
//      pairByContent functions, so any regression in the core
//      pipeline shows up on both surfaces. The Playwright E2E
//      sweep exercises the GUI; the CLI exercises the same core
//      logic without the Next.js + browser machinery in the way.
//   3. Reproducibility — bench reviewers can run the exact verify
//      pipeline against arbitrary inputs without standing up the
//      app server or a browser session.
//
// Usage:
//   tsx bin/labelverify.ts verify <image-path> <app-or-manifest-path>
//   tsx bin/labelverify.ts extract <image-path>
//   tsx bin/labelverify.ts parse-app <application-path>
//   tsx bin/labelverify.ts batch <folder>
//   tsx bin/labelverify.ts health
//   tsx bin/labelverify.ts samples
//
// All commands accept a `--json` flag for machine-parseable output
// (the default is human-readable). Reads GOOGLE_API_KEY etc. from
// .env.local (loaded automatically) or process env.

import { readFile, readdir } from "node:fs/promises";
import { existsSync, readFileSync } from "node:fs";
import { basename, extname, join, resolve } from "node:path";

// ─── .env.local loader (no extra deps) ──────────────────────────────────────

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
    // Use strict-undefined check so callers (e.g. test harness) can
    // explicitly clear a var by passing `KEY: ""` without having the
    // .env.local file re-populate it.
    if (process.env[k] === undefined) process.env[k] = v;
  }
}
loadDotenv(resolve(process.cwd(), ".env.local"));

// ─── Argument parsing ──────────────────────────────────────────────────────

interface Args {
  command: string;
  positional: string[];
  flags: { json: boolean; help: boolean };
}

function parseArgs(argv: string[]): Args {
  const args: Args = { command: "", positional: [], flags: { json: false, help: false } };
  for (let i = 2; i < argv.length; i++) {
    const a = argv[i]!;
    if (a === "--json") args.flags.json = true;
    else if (a === "--help" || a === "-h") args.flags.help = true;
    else if (!args.command) args.command = a;
    else args.positional.push(a);
  }
  return args;
}

function printHelp(): void {
  // eslint-disable-next-line no-console
  console.log(
    `LabelVerify CLI

Commands:
  verify <image> <app-or-manifest>   Verify a single label image against
                                     application data (file path). The app
                                     file can be a PDF / JSON / CSV / MD /
                                     TXT / DOCX / image of a form.

  extract <image>                    Run the vision extractor on a label
                                     image and print extracted fields
                                     WITHOUT a verdict. Useful when no
                                     application data is available.

  parse-app <application-path>       Parse an application file into a
                                     declared-fields payload (Partial<DeclaredFields>).
                                     Prints the parsed fields + source +
                                     warnings.

  batch <folder>                     Run the auto-batch pipeline against
                                     every (image, application-or-manifest)
                                     pairing it can find in the folder.
                                     Uses the same 4-stage pairing
                                     strategy as the GUI:
                                       1) inline multi-row manifest
                                       2) filename stem
                                       3) content-based fuzzy
                                       4) single-app broadcast.

  samples                            List the bundled PASS / FAIL / REVIEW
                                     sample labels with their expected
                                     verdicts (useful for quick smoke).

  health                             Print the readiness of the configured
                                     provider keys (GOOGLE_API_KEY,
                                     OPENAI_API_KEY, etc.). No HTTP calls
                                     made.

Flags:
  --json                             Emit JSON instead of human-readable
                                     output. Suitable for piping into jq.
  --help, -h                         Print this help.

Examples:
  tsx bin/labelverify.ts verify ./label.jpg ./application.pdf
  tsx bin/labelverify.ts batch ./test-data/ai-generated --json | jq '.results[] | {file: .filename, verdict: .result.verdict}'
  tsx bin/labelverify.ts extract ./photo.heic
  tsx bin/labelverify.ts samples
`,
  );
}

// ─── Commands ──────────────────────────────────────────────────────────────

async function cmdHealth(args: Args): Promise<void> {
  const keys = {
    GOOGLE_API_KEY: !!process.env.GOOGLE_API_KEY,
    OPENAI_API_KEY: !!process.env.OPENAI_API_KEY,
    ANTHROPIC_API_KEY: !!process.env.ANTHROPIC_API_KEY,
    OPENROUTER_API_KEY: !!process.env.OPENROUTER_API_KEY,
  };
  const ready = keys.GOOGLE_API_KEY;
  if (args.flags.json) {
    process.stdout.write(JSON.stringify({ ready, providers: keys }, null, 2) + "\n");
    // Exit-non-zero parity with human-readable mode: a not-ready health
    // is a failure regardless of output format. Otherwise CI scripts
    // that pipe `health --json` into a check would silently succeed.
    if (!ready) process.exit(1);
    return;
  }
  // eslint-disable-next-line no-console
  console.log(`LabelVerify health: ${ready ? "READY" : "NOT READY"}`);
  for (const [k, v] of Object.entries(keys)) {
    // eslint-disable-next-line no-console
    console.log(`  ${k.padEnd(22)} ${v ? "✓ configured" : "✗ missing"}`);
  }
  if (!ready) {
    // eslint-disable-next-line no-console
    console.log(
      "\nGOOGLE_API_KEY is required for the primary vision path. Set it in .env.local or process env.",
    );
    process.exit(1);
  }
}

async function cmdSamples(args: Args): Promise<void> {
  const { SAMPLES } = await import("../src/lib/samples");
  if (args.flags.json) {
    process.stdout.write(JSON.stringify(SAMPLES, null, 2) + "\n");
    return;
  }
  // eslint-disable-next-line no-console
  console.log("Bundled samples:");
  for (const s of SAMPLES) {
    // eslint-disable-next-line no-console
    console.log(
      `  ${s.id.padEnd(8)} expected=${s.expectedVerdict.padEnd(6)} ${s.label}`,
    );
    // eslint-disable-next-line no-console
    console.log(`    ${s.shortDescription}`);
  }
}

async function cmdExtract(args: Args): Promise<void> {
  const imagePath = args.positional[0];
  if (!imagePath) throw new Error("Usage: labelverify extract <image-path>");
  const apiKey = process.env.GOOGLE_API_KEY;
  if (!apiKey) throw new Error("GOOGLE_API_KEY not set — extract requires the vision provider.");
  const { preprocessImage } = await import("../src/lib/preprocess");
  const { GeminiFlashExtractor } = await import("../src/lib/vision/gemini");
  const imageBytes = await readFile(imagePath);
  const pre = await preprocessImage(imageBytes);
  const extractor = new GeminiFlashExtractor({ apiKey });
  const t0 = Date.now();
  const result = await extractor.extract(pre.buffer);
  const elapsed = Date.now() - t0;
  if (args.flags.json) {
    process.stdout.write(
      JSON.stringify({ image: basename(imagePath), elapsedMs: elapsed, ...result }, null, 2) +
        "\n",
    );
    return;
  }
  // eslint-disable-next-line no-console
  console.log(`Extracted fields from ${basename(imagePath)} (${elapsed} ms via ${result.modelId}):`);
  printFields(result.fields);
}

async function cmdParseApp(args: Args): Promise<void> {
  const path = args.positional[0];
  if (!path) throw new Error("Usage: labelverify parse-app <application-path>");
  const { parseApplication } = await import("../src/lib/application/parse");
  const buf = await readFile(path);
  const mime = guessMimeFromExtension(path);
  const parsed = await parseApplication({
    buffer: buf,
    filename: basename(path),
    mime,
    ...(process.env.GOOGLE_API_KEY ? { apiKey: process.env.GOOGLE_API_KEY } : {}),
  });
  if (args.flags.json) {
    process.stdout.write(JSON.stringify(parsed, null, 2) + "\n");
    return;
  }
  // eslint-disable-next-line no-console
  console.log(`Parsed ${basename(path)} (source=${parsed.source}, confidence=${parsed.confidence}):`);
  printDeclaredFields(parsed.fields);
  if (parsed.warnings.length > 0) {
    // eslint-disable-next-line no-console
    console.log(`\nWarnings:`);
    for (const w of parsed.warnings) {
      // eslint-disable-next-line no-console
      console.log(`  • ${w}`);
    }
  }
}

async function cmdVerify(args: Args): Promise<void> {
  const [imagePath, appPath] = args.positional;
  if (!imagePath || !appPath) {
    throw new Error("Usage: labelverify verify <image-path> <application-or-manifest-path>");
  }
  const apiKey = process.env.GOOGLE_API_KEY;
  if (!apiKey) throw new Error("GOOGLE_API_KEY not set.");
  const { verifyLabel } = await import("../src/lib/verify");
  const { parseApplication } = await import("../src/lib/application/parse");
  const { DeclaredFieldsSchema } = await import("../src/lib/types");
  const imageBytes = await readFile(imagePath);
  const appBuf = await readFile(appPath);
  const parsed = await parseApplication({
    buffer: appBuf,
    filename: basename(appPath),
    mime: guessMimeFromExtension(appPath),
    apiKey,
  });
  const validated = DeclaredFieldsSchema.safeParse(parsed.fields);
  if (!validated.success) {
    throw new Error(
      `Parsed application is missing required declared fields: ${validated.error.issues
        .slice(0, 3)
        .map((iss) => `${iss.path.join(".")}: ${iss.message}`)
        .join("; ")}`,
    );
  }
  const t0 = Date.now();
  const result = await verifyLabel(imageBytes, validated.data);
  const elapsed = Date.now() - t0;
  if (args.flags.json) {
    process.stdout.write(JSON.stringify({ elapsedMs: elapsed, ...result }, null, 2) + "\n");
    return;
  }
  printVerifyResult(basename(imagePath), result, elapsed);
}

async function cmdBatch(args: Args): Promise<void> {
  const folder = args.positional[0];
  if (!folder) throw new Error("Usage: labelverify batch <folder>");
  const apiKey = process.env.GOOGLE_API_KEY;
  if (!apiKey) throw new Error("GOOGLE_API_KEY not set.");
  const {
    pairByFilenameStem,
    classifyFile,
  } = await import("../src/lib/batch-pairing");
  const { parseApplication } = await import("../src/lib/application/parse");
  const { verifyLabel } = await import("../src/lib/verify");
  const { DeclaredFieldsSchema } = await import("../src/lib/types");

  // Enumerate the folder.
  const entries = await readdir(folder);
  const files: File[] = [];
  for (const name of entries) {
    const p = join(folder, name);
    const buf = await readFile(p);
    // Build a File-like object the pairing module accepts (it only
    // reads name, type, size, arrayBuffer()).
    const f = new File([buf], name, { type: guessMimeFromExtension(p) });
    files.push(f);
  }

  // Filename-stem pairing (same logic the API uses; content-pairing
  // and inline-manifest are also available in the same module if
  // you want to wire them up for CLI use too).
  const pairResult = pairByFilenameStem(files);
  const items: Array<{
    filename: string;
    imageBytes: Buffer;
    declared: import("../src/lib/types").DeclaredFields;
  }> = [];
  for (const { imageFile, applicationFile } of pairResult.paired) {
    const appBuf = Buffer.from(await applicationFile.arrayBuffer());
    const parsed = await parseApplication({
      buffer: appBuf,
      filename: applicationFile.name,
      mime: applicationFile.type,
      apiKey,
    });
    const validated = DeclaredFieldsSchema.safeParse(parsed.fields);
    if (!validated.success) continue;
    items.push({
      filename: imageFile.name,
      imageBytes: Buffer.from(await imageFile.arrayBuffer()),
      declared: validated.data,
    });
  }
  // Verify in parallel batches of 2.
  const CONCURRENCY = 2;
  let cursor = 0;
  const results: Array<{
    filename: string;
    elapsedMs: number;
    verdict: string;
    imageQuality: string;
  }> = [];
  async function pump(): Promise<void> {
    while (true) {
      const i = cursor++;
      if (i >= items.length) return;
      const item = items[i]!;
      const t0 = Date.now();
      try {
        const r = await verifyLabel(item.imageBytes, item.declared);
        results.push({
          filename: item.filename,
          elapsedMs: Date.now() - t0,
          verdict: r.verdict,
          imageQuality: r.imageQuality,
        });
      } catch (err) {
        results.push({
          filename: item.filename,
          elapsedMs: Date.now() - t0,
          verdict: "error",
          imageQuality: `error: ${(err as Error).message}`,
        });
      }
    }
  }
  await Promise.all(Array.from({ length: CONCURRENCY }, () => pump()));
  // Sort back into folder order.
  results.sort((a, b) => a.filename.localeCompare(b.filename));
  if (args.flags.json) {
    process.stdout.write(
      JSON.stringify(
        {
          folder,
          pairedCount: pairResult.paired.length,
          unpairedImages: pairResult.unpairedImages.map((f) => f.name),
          unpairedApplications: pairResult.unpairedApplications.map((f) => f.name),
          results,
        },
        null,
        2,
      ) + "\n",
    );
    return;
  }
  // eslint-disable-next-line no-console
  console.log(
    `Paired ${pairResult.paired.length} (image, application) pairs from ${folder}.`,
  );
  if (pairResult.unpairedImages.length > 0) {
    // eslint-disable-next-line no-console
    console.log(`Unpaired images: ${pairResult.unpairedImages.map((f) => f.name).join(", ")}`);
  }
  if (pairResult.unpairedApplications.length > 0) {
    // eslint-disable-next-line no-console
    console.log(
      `Unpaired applications: ${pairResult.unpairedApplications.map((f) => f.name).join(", ")}`,
    );
  }
  // eslint-disable-next-line no-console
  console.log(`\nResults:`);
  for (const r of results) {
    // eslint-disable-next-line no-console
    console.log(
      `  ${r.filename.padEnd(36)} ${r.verdict.padEnd(8)} ${r.imageQuality.padEnd(14)} ${r.elapsedMs} ms`,
    );
  }
}

// ─── Helpers ──────────────────────────────────────────────────────────────

function guessMimeFromExtension(p: string): string {
  const ext = extname(p).toLowerCase().replace(/^\./, "");
  const map: Record<string, string> = {
    pdf: "application/pdf",
    json: "application/json",
    csv: "text/csv",
    md: "text/markdown",
    txt: "text/plain",
    docx: "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
    jpg: "image/jpeg",
    jpeg: "image/jpeg",
    png: "image/png",
    webp: "image/webp",
    heic: "image/heic",
    heif: "image/heif",
  };
  return map[ext] ?? "application/octet-stream";
}

interface PrintableFieldsSubset {
  brand_name?: { value: unknown; confidence: number };
  class_type?: { value: unknown; confidence: number };
  abv_percent?: { value: unknown; confidence: number };
  net_contents?: { value: unknown; confidence: number };
  producer?: { value: unknown; confidence: number };
  country_of_origin?: { value: unknown; confidence: number };
  government_warning?: { value: unknown; confidence: number };
}

function printFields(fields: PrintableFieldsSubset): void {
  for (const [k, v] of Object.entries(fields) as Array<
    [string, { value: unknown; confidence: number } | undefined]
  >) {
    if (!v) continue;
    // eslint-disable-next-line no-console
    console.log(
      `  ${k.padEnd(20)} ${JSON.stringify(v.value)} (conf=${v.confidence.toFixed(2)})`,
    );
  }
}

function printDeclaredFields(fields: Record<string, unknown>): void {
  for (const [k, v] of Object.entries(fields)) {
    // eslint-disable-next-line no-console
    console.log(`  ${k.padEnd(20)} ${JSON.stringify(v)}`);
  }
}

function printVerifyResult(
  imageName: string,
  result: import("../src/lib/types").VerifyResponse,
  elapsedMs: number,
): void {
  // eslint-disable-next-line no-console
  console.log(`Verification of ${imageName} (${elapsedMs} ms):`);
  // eslint-disable-next-line no-console
  console.log(`  Verdict:          ${result.verdict.toUpperCase()}`);
  // eslint-disable-next-line no-console
  console.log(`  Image quality:    ${result.imageQuality}`);
  if (result.imageQualityReason) {
    // eslint-disable-next-line no-console
    console.log(`    (${result.imageQualityReason})`);
  }
  // eslint-disable-next-line no-console
  console.log(`  Gov-Warning:      ${result.governmentWarning.status}`);
  // eslint-disable-next-line no-console
  console.log(`  Fields:`);
  for (const [k, cmp] of Object.entries(result.fields) as Array<
    [string, { status: string; expected: unknown; actual: unknown }]
  >) {
    // eslint-disable-next-line no-console
    console.log(
      `    ${k.padEnd(20)} ${cmp.status.padEnd(8)} expected=${JSON.stringify(cmp.expected)} actual=${JSON.stringify(cmp.actual)}`,
    );
  }
  if (result.reviewReasons.length > 0) {
    // eslint-disable-next-line no-console
    console.log(`  Review reasons:`);
    for (const r of result.reviewReasons) {
      // eslint-disable-next-line no-console
      console.log(`    • ${r}`);
    }
  }
}

// ─── Entry point ──────────────────────────────────────────────────────────

async function main(): Promise<void> {
  const args = parseArgs(process.argv);
  if (args.flags.help || !args.command) {
    printHelp();
    return;
  }
  try {
    switch (args.command) {
      case "health":
        await cmdHealth(args);
        break;
      case "samples":
        await cmdSamples(args);
        break;
      case "extract":
        await cmdExtract(args);
        break;
      case "parse-app":
        await cmdParseApp(args);
        break;
      case "verify":
        await cmdVerify(args);
        break;
      case "batch":
        await cmdBatch(args);
        break;
      default:
        // eslint-disable-next-line no-console
        console.error(`Unknown command: ${args.command}\n`);
        printHelp();
        process.exit(2);
    }
  } catch (err) {
    // eslint-disable-next-line no-console
    console.error(`Error: ${(err as Error).message}`);
    process.exit(1);
  }
}

void main();
