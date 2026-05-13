#!/usr/bin/env tsx
// bin/labelverify-web.ts
//
// Web-app driver CLI for LabelVerify. The second of two CLIs:
//
//   - bin/labelverify.ts        → operator CLI; calls the backend
//                                 modules directly (no HTTP, no
//                                 browser, no Next.js server). Best for
//                                 scripted bulk runs, CI, and reviewer
//                                 reproducibility.
//
//   - bin/labelverify-web.ts    → web-app driver CLI; hits the deployed
//                                 HTTP API the same way the browser
//                                 does. Best for smoke-testing
//                                 production, dogfooding the multipart
//                                 contract, and giving a CLI front-end
//                                 to anyone who'd rather not open a
//                                 browser (but does want to talk to the
//                                 hosted service).
//
// Why both: the in-process CLI and the HTTP CLI exercise different
// failure surfaces. The operator CLI catches regressions in the core
// verify pipeline. The web-driver CLI catches regressions in the
// Next.js route layer (multipart parsing, rate-limiting, MIME handling,
// serverless cold-start, etc.) — the same layer the browser touches.
// Shipping both means a class of GUI-only bugs (like the Vercel
// serverless instance-isolation 404 we hit on 2026-05-13) gets caught
// by a non-browser test surface BEFORE the user reports it.
//
// Usage:
//   tsx bin/labelverify-web.ts verify <image-path> <app-or-manifest-path>
//   tsx bin/labelverify-web.ts extract <image-path>
//   tsx bin/labelverify-web.ts batch <folder>
//   tsx bin/labelverify-web.ts health
//   tsx bin/labelverify-web.ts samples
//
// Flags:
//   --base-url <url>   Base URL (default: https://label-verify-six.vercel.app)
//   --local            Shorthand for --base-url http://localhost:3000
//   --json             Emit JSON instead of human-readable output
//   --timeout <ms>     Per-request timeout (default 90000)
//   -h, --help         Print help
//
// Reads no env vars; the deployed backend supplies its own keys.

import { readFile, readdir, stat } from "node:fs/promises";
import { basename, extname, resolve } from "node:path";

const DEFAULT_BASE_URL =
  process.env.LABELVERIFY_BASE_URL ?? "https://label-verify-six.vercel.app";
const LOCAL_BASE_URL = "http://localhost:3000";
const DEFAULT_TIMEOUT_MS = 90_000;

// ─── Argument parsing ──────────────────────────────────────────────────────

interface Args {
  command: string;
  positional: string[];
  flags: {
    json: boolean;
    help: boolean;
    local: boolean;
    baseUrl?: string;
    timeoutMs: number;
  };
}

function parseArgs(argv: string[]): Args {
  const args: Args = {
    command: "",
    positional: [],
    flags: { json: false, help: false, local: false, timeoutMs: DEFAULT_TIMEOUT_MS },
  };
  for (let i = 2; i < argv.length; i++) {
    const a = argv[i]!;
    if (a === "--json") args.flags.json = true;
    else if (a === "--help" || a === "-h") args.flags.help = true;
    else if (a === "--local") args.flags.local = true;
    else if (a === "--base-url") {
      const next = argv[++i];
      if (!next) throw new Error("--base-url requires a value");
      args.flags.baseUrl = next;
    } else if (a === "--timeout") {
      const next = argv[++i];
      if (!next) throw new Error("--timeout requires a value (ms)");
      const n = Number(next);
      if (!Number.isFinite(n) || n <= 0) {
        throw new Error("--timeout must be a positive number of ms");
      }
      args.flags.timeoutMs = n;
    } else if (!args.command) args.command = a;
    else args.positional.push(a);
  }
  return args;
}

function resolveBaseUrl(args: Args): string {
  if (args.flags.baseUrl) return args.flags.baseUrl.replace(/\/+$/, "");
  if (args.flags.local) return LOCAL_BASE_URL;
  return DEFAULT_BASE_URL.replace(/\/+$/, "");
}

function printHelp(): void {
  // eslint-disable-next-line no-console
  console.log(
    `LabelVerify web-driver CLI (HTTP)

Hits the deployed (or local) web app via HTTP — the same surface a
browser talks to. For a no-network in-process equivalent, see
bin/labelverify.ts.

Commands:
  verify <image> <app-or-manifest>   POST /api/verify with the image
                                     and a JSON-encoded \`declared\`
                                     field parsed from <app-or-manifest>
                                     (which may be JSON, CSV, MD, TXT,
                                     DOCX, PDF, or an image of a form).

  extract <image>                    POST /api/extract with the image.
                                     Returns extracted fields + GW
                                     subscore. No verdict.

  batch <folder>                     POST /api/verify/batch with every
                                     image + application file in
                                     <folder> (auto-pairs by filename
                                     stem, then by content fallback).
                                     Streams results back inline.

  health                             GET /api/health. Exits 1 if the
                                     deployed service reports
                                     \`ready: false\`.

  samples                            List the bundled samples
                                     (pass/fail/review) the GUI offers.

Flags:
  --base-url <url>   Hit a different host. Default:
                     ${DEFAULT_BASE_URL}
  --local            Shorthand for --base-url ${LOCAL_BASE_URL}
                     (use when running 'npm run dev' locally).
  --json             Machine-readable JSON output (default: human-
                     readable). Exit codes are unchanged.
  --timeout <ms>     Per-request HTTP timeout. Default ${DEFAULT_TIMEOUT_MS}.
  -h, --help         This help.

Exit codes:
  0  success / verdict=pass
  1  network or HTTP error, or verdict=fail / review on a verify
  2  bad CLI arguments
`,
  );
}

// ─── HTTP helpers ──────────────────────────────────────────────────────────

interface HttpJson<T> {
  status: number;
  body: T | null;
  text: string;
}

async function httpJson<T = unknown>(
  url: string,
  init: RequestInit,
  timeoutMs: number,
): Promise<HttpJson<T>> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const res = await fetch(url, { ...init, signal: controller.signal });
    const text = await res.text();
    let parsed: T | null = null;
    try {
      parsed = text ? (JSON.parse(text) as T) : null;
    } catch {
      parsed = null;
    }
    return { status: res.status, body: parsed, text };
  } finally {
    clearTimeout(timer);
  }
}

function mimeForExt(name: string): string {
  const ext = extname(name).toLowerCase();
  switch (ext) {
    case ".jpg":
    case ".jpeg":
      return "image/jpeg";
    case ".png":
      return "image/png";
    case ".webp":
      return "image/webp";
    case ".heic":
      return "image/heic";
    case ".heif":
      return "image/heif";
    case ".pdf":
      return "application/pdf";
    case ".json":
      return "application/json";
    case ".csv":
      return "text/csv";
    case ".md":
      return "text/markdown";
    case ".txt":
      return "text/plain";
    case ".docx":
      return "application/vnd.openxmlformats-officedocument.wordprocessingml.document";
    default:
      return "application/octet-stream";
  }
}

async function fileBlob(path: string): Promise<{ blob: Blob; name: string }> {
  const buf = await readFile(path);
  const name = basename(path);
  // Use a strongly-typed Uint8Array to satisfy Blob's BlobPart contract on
  // both Node 20 (undici-backed fetch) and Node 22+. Casting through
  // ArrayBuffer for HEIC/HEIF (which sharp can't read on Node 20 without
  // libvips support) just preserves the bytes for upload — the server
  // will reject unsupported MIMEs cleanly.
  const blob = new Blob([new Uint8Array(buf)], { type: mimeForExt(name) });
  return { blob, name };
}

// ─── parse-app on the client side ──────────────────────────────────────────
//
// We could POST <app-or-manifest> to a dedicated parser route, but the
// app already exposes /api/application/parse for that. Calling that
// route to get the `declared` JSON, then POSTing /api/verify with the
// result, mirrors exactly what the browser does.

async function parseApplicationViaHttp(
  baseUrl: string,
  appPath: string,
  timeoutMs: number,
): Promise<unknown> {
  const { blob, name } = await fileBlob(appPath);
  const form = new FormData();
  form.append("file", blob, name);
  const res = await httpJson<{ declared?: unknown; error?: string }>(
    `${baseUrl}/api/application/parse`,
    { method: "POST", body: form },
    timeoutMs,
  );
  if (res.status !== 200 || !res.body || !res.body.declared) {
    throw new Error(
      `parse-app failed (HTTP ${res.status}): ${res.body?.error ?? res.text.slice(0, 200)}`,
    );
  }
  return res.body.declared;
}

// ─── verify ────────────────────────────────────────────────────────────────

async function cmdVerify(args: Args): Promise<void> {
  if (args.positional.length < 2) {
    process.stderr.write("verify requires <image> <app-or-manifest>\n");
    process.exit(2);
  }
  const baseUrl = resolveBaseUrl(args);
  const [imagePath, appPath] = args.positional as [string, string];

  const declared = await parseApplicationViaHttp(
    baseUrl,
    resolve(appPath),
    args.flags.timeoutMs,
  );
  const { blob, name } = await fileBlob(resolve(imagePath));
  const form = new FormData();
  form.append("image", blob, name);
  form.append("declared", JSON.stringify(declared));

  const res = await httpJson<{
    verdict?: string;
    imageQuality?: string;
    error?: string;
  }>(`${baseUrl}/api/verify`, { method: "POST", body: form }, args.flags.timeoutMs);

  if (res.status !== 200 || !res.body) {
    if (args.flags.json) {
      process.stdout.write(
        JSON.stringify(
          { ok: false, status: res.status, error: res.body?.error ?? res.text },
          null,
          2,
        ) + "\n",
      );
    } else {
      process.stderr.write(
        `verify failed (HTTP ${res.status}): ${res.body?.error ?? res.text.slice(0, 200)}\n`,
      );
    }
    process.exit(1);
  }

  if (args.flags.json) {
    process.stdout.write(JSON.stringify(res.body, null, 2) + "\n");
  } else {
    const verdict = String(res.body.verdict ?? "?").toUpperCase();
    const iq = String(res.body.imageQuality ?? "?");
    process.stdout.write(
      `verify ${baseUrl}: verdict=${verdict}  imageQuality=${iq}\n`,
    );
  }
  if (res.body.verdict && res.body.verdict !== "pass") process.exit(1);
}

// ─── extract ───────────────────────────────────────────────────────────────

async function cmdExtract(args: Args): Promise<void> {
  if (args.positional.length < 1) {
    process.stderr.write("extract requires <image>\n");
    process.exit(2);
  }
  const baseUrl = resolveBaseUrl(args);
  const [imagePath] = args.positional as [string];
  const { blob, name } = await fileBlob(resolve(imagePath));
  const form = new FormData();
  form.append("image", blob, name);

  const res = await httpJson<{ extracted?: unknown; error?: string }>(
    `${baseUrl}/api/extract`,
    { method: "POST", body: form },
    args.flags.timeoutMs,
  );
  if (res.status !== 200 || !res.body) {
    if (args.flags.json) {
      process.stdout.write(
        JSON.stringify(
          { ok: false, status: res.status, error: res.body?.error ?? res.text },
          null,
          2,
        ) + "\n",
      );
    } else {
      process.stderr.write(
        `extract failed (HTTP ${res.status}): ${res.body?.error ?? res.text.slice(0, 200)}\n`,
      );
    }
    process.exit(1);
  }
  process.stdout.write(JSON.stringify(res.body, null, 2) + "\n");
}

// ─── batch ─────────────────────────────────────────────────────────────────

async function cmdBatch(args: Args): Promise<void> {
  if (args.positional.length < 1) {
    process.stderr.write("batch requires <folder>\n");
    process.exit(2);
  }
  const baseUrl = resolveBaseUrl(args);
  const folder = resolve(args.positional[0]!);
  const folderStat = await stat(folder);
  if (!folderStat.isDirectory()) {
    process.stderr.write(`Not a directory: ${folder}\n`);
    process.exit(2);
  }
  const entries = await readdir(folder);
  const imageExts = new Set([".jpg", ".jpeg", ".png", ".webp"]);
  const appExts = new Set([".json", ".csv", ".md", ".txt", ".docx", ".pdf"]);
  const images: string[] = [];
  const apps: string[] = [];
  for (const e of entries) {
    const ext = extname(e).toLowerCase();
    if (imageExts.has(ext)) images.push(e);
    else if (appExts.has(ext)) apps.push(e);
  }
  if (images.length === 0) {
    process.stderr.write(`No images found in ${folder}\n`);
    process.exit(2);
  }

  const form = new FormData();
  for (const img of images) {
    const { blob, name } = await fileBlob(resolve(folder, img));
    form.append("images", blob, name);
  }
  for (const app of apps) {
    const { blob, name } = await fileBlob(resolve(folder, app));
    form.append("applications", blob, name);
  }

  const res = await httpJson<{
    results?: Array<{ filename?: string; status?: string; result?: { verdict?: string } }>;
    error?: string;
  }>(
    `${baseUrl}/api/verify/batch`,
    { method: "POST", body: form },
    args.flags.timeoutMs,
  );
  if (res.status !== 200 || !res.body) {
    if (args.flags.json) {
      process.stdout.write(
        JSON.stringify(
          { ok: false, status: res.status, error: res.body?.error ?? res.text },
          null,
          2,
        ) + "\n",
      );
    } else {
      process.stderr.write(
        `batch failed (HTTP ${res.status}): ${res.body?.error ?? res.text.slice(0, 200)}\n`,
      );
    }
    process.exit(1);
  }

  if (args.flags.json) {
    process.stdout.write(JSON.stringify(res.body, null, 2) + "\n");
    return;
  }
  const results = res.body.results ?? [];
  let pass = 0,
    fail = 0,
    review = 0,
    errored = 0;
  for (const r of results) {
    const v = r.result?.verdict;
    if (v === "pass") pass++;
    else if (v === "fail") fail++;
    else if (v === "review") review++;
    else errored++;
    process.stdout.write(`${r.filename}: ${v ?? r.status}\n`);
  }
  process.stdout.write(
    `\nbatch: ${results.length} items — pass=${pass} fail=${fail} review=${review} errored=${errored}\n`,
  );
}

// ─── health ────────────────────────────────────────────────────────────────

async function cmdHealth(args: Args): Promise<void> {
  const baseUrl = resolveBaseUrl(args);
  const res = await httpJson<{
    ok?: boolean;
    ready?: boolean;
    notes?: string[];
    service?: string;
  }>(`${baseUrl}/api/health`, { method: "GET" }, args.flags.timeoutMs);
  if (args.flags.json) {
    process.stdout.write(
      JSON.stringify(
        { status: res.status, body: res.body ?? res.text },
        null,
        2,
      ) + "\n",
    );
    if (res.status !== 200 || !res.body?.ready) process.exit(1);
    return;
  }
  if (res.status !== 200 || !res.body) {
    process.stderr.write(`health: HTTP ${res.status} from ${baseUrl}\n`);
    process.exit(1);
  }
  const ready = res.body.ready ? "READY" : "NOT READY";
  process.stdout.write(`${baseUrl}/api/health: ${ready}\n`);
  for (const n of res.body.notes ?? []) process.stdout.write(`  - ${n}\n`);
  if (!res.body.ready) process.exit(1);
}

// ─── samples ───────────────────────────────────────────────────────────────
//
// The GUI's sample buttons (pass/fail/review) just POST the three
// bundled images at /samples/{pass,fail,review}.jpg through the standard
// verify flow. We don't expose those metadata over HTTP (no /api/samples)
// — it's a frontend-only list. Mirror it here so this CLI is feature-
// complete with the GUI surface.

// The REVIEW sample intentionally reuses the PASS image. The deferral
// is engineered by a class_type mismatch (label prints "Pilsner",
// declared says "Lager") — both are real labels in production, and
// TTB treats them as distinct class designations. See
// src/lib/samples.ts:97-121 for the canonical metadata. We mirror it
// here so this CLI lists the same three affordances the GUI offers.
const SAMPLES = [
  { id: "pass", expectedVerdict: "pass", path: "/samples/pass.jpg" },
  { id: "fail", expectedVerdict: "fail", path: "/samples/fail.jpg" },
  { id: "review", expectedVerdict: "review", path: "/samples/pass.jpg" },
] as const;

function cmdSamples(args: Args): void {
  if (args.flags.json) {
    process.stdout.write(JSON.stringify(SAMPLES, null, 2) + "\n");
    return;
  }
  process.stdout.write("Bundled samples (served from the web app):\n");
  for (const s of SAMPLES) {
    process.stdout.write(
      `  ${s.id.padEnd(8)} expected=${s.expectedVerdict.padEnd(8)} ${s.path}\n`,
    );
  }
}

// ─── main ──────────────────────────────────────────────────────────────────

async function main(): Promise<void> {
  let args: Args;
  try {
    args = parseArgs(process.argv);
  } catch (err) {
    process.stderr.write(`${(err as Error).message}\n`);
    printHelp();
    process.exit(2);
  }

  if (args.flags.help || (!args.command && process.argv.length <= 2)) {
    printHelp();
    return;
  }
  if (!args.command) {
    printHelp();
    return;
  }

  switch (args.command) {
    case "verify":
      await cmdVerify(args);
      return;
    case "extract":
      await cmdExtract(args);
      return;
    case "batch":
      await cmdBatch(args);
      return;
    case "health":
      await cmdHealth(args);
      return;
    case "samples":
      cmdSamples(args);
      return;
    default:
      process.stderr.write(`Unknown command: ${args.command}\n`);
      printHelp();
      process.exit(2);
  }
}

main().catch((err: Error) => {
  process.stderr.write(`${err.stack ?? err.message}\n`);
  process.exit(1);
});
