#!/usr/bin/env tsx
// bin/verify-claims.ts
//
// Wave-35e: standardised drift detector. Asserts that every numeric /
// path / wave-name / env-var claim that appears in user-visible docs
// (README, CHANGELOG, CONTRIBUTING, docs/*.md) and GUI strings is
// consistent with the canonical source of truth (the code + bench
// artifacts + filesystem).
//
// Designed to be run locally before a PR ("npm run verify:claims")
// AND in CI as a non-skippable gate, so docs cannot drift out from
// under main without the build going red.
//
// Apex framework anchor: §13.8a claim ledger — every claim a project
// makes is rooted in a verifiable source. This script enforces that
// every claim either matches reality OR is explicitly marked as
// historical / superseded.
//
// Output policy:
//   - Exit 0 if all checks pass (no drift).
//   - Exit 1 if ANY check fails. Print each finding with file:line,
//     the current (incorrect) claim, and the expected value.
//   - "Warnings" (likely-stale-but-arguable) are printed but do
//     not change exit code, so the script can be tightened over
//     time without becoming a tripwire for trivial things.

import { readdirSync, readFileSync, existsSync, statSync } from "node:fs";
import { join, relative } from "node:path";

interface Finding {
  severity: "error" | "warning";
  file: string;
  line?: number;
  claim: string;
  expected: string;
  category: string;
}

const ROOT = process.cwd();
const findings: Finding[] = [];

function err(category: string, file: string, claim: string, expected: string, line?: number): void {
  findings.push({ severity: "error", category, file, line, claim, expected });
}
function warn(category: string, file: string, claim: string, expected: string, line?: number): void {
  findings.push({ severity: "warning", category, file, line, claim, expected });
}

function readIfExists(p: string): string | null {
  try {
    return readFileSync(join(ROOT, p), "utf-8");
  } catch {
    return null;
  }
}

function walk(dir: string, predicate: (path: string) => boolean): string[] {
  const out: string[] = [];
  const stack = [dir];
  while (stack.length > 0) {
    const d = stack.pop()!;
    let entries: string[];
    try {
      entries = readdirSync(d);
    } catch {
      continue;
    }
    for (const name of entries) {
      const p = join(d, name);
      let st: ReturnType<typeof statSync>;
      try {
        st = statSync(p);
      } catch {
        continue;
      }
      if (st.isDirectory()) {
        if (name === "node_modules" || name === ".next" || name === ".git") continue;
        stack.push(p);
      } else if (predicate(p)) {
        out.push(p);
      }
    }
  }
  return out;
}

// ─── Compute ground truths ──────────────────────────────────────────────────

/** Count vitest `it(` and `test(` invocations across src/tests/**.
 *  Approximate but stable: not every `it()` runs (some `.skip`), but the
 *  count drifts at the same rate as the README's claim does, so it's
 *  fit-for-purpose as a drift detector. The script reports the
 *  approximate number alongside any tighter constraint. */
function countTestInvocations(): number {
  const testFiles = walk(join(ROOT, "src", "tests"), (p) => /\.test\.(ts|tsx)$/.test(p));
  let n = 0;
  for (const f of testFiles) {
    const src = readFileSync(f, "utf-8");
    // Match `it(` and `test(` at the start of an expression — guarded by a
    // preceding whitespace / brace / line-start to avoid e.g. `wait(...)`.
    const re = /(^|[\s;{}])(it|test)\s*\(/gm;
    n += (src.match(re) || []).length;
  }
  return n;
}

function countTestFiles(): number {
  return walk(join(ROOT, "src", "tests"), (p) => /\.test\.(ts|tsx)$/.test(p)).length;
}

/** Latest bench result on disk — used for pass-rate / latency comparisons.
 *  Looks at `benchmarks/results/wave35-supplemental-crops/baseline-run1.json`
 *  by preference (the most recent N=2 baseline measured on current main),
 *  falling back to the newest cross-pair-*.json. */
function loadLatestBench(): { source: string; summary: { passRateOnCorrect: number; errors: number; latencyMs?: { p50_total?: number } } } | null {
  const preferred = [
    "benchmarks/results/wave35-supplemental-crops/baseline-run1.json",
    "benchmarks/results/wave35-supplemental-crops/baseline-run2.json",
  ];
  for (const p of preferred) {
    if (existsSync(join(ROOT, p))) {
      try {
        const raw = readFileSync(join(ROOT, p), "utf-8");
        const j = JSON.parse(raw) as { summary?: { passRateOnCorrect?: number; errors?: number; latencyMs?: { p50_total?: number } } };
        if (j.summary?.passRateOnCorrect != null) {
          return { source: p, summary: { passRateOnCorrect: j.summary.passRateOnCorrect, errors: j.summary.errors ?? 0, latencyMs: j.summary.latencyMs } };
        }
      } catch {
        // ignore, fall through
      }
    }
  }
  // Fallback: newest cross-pair-*.json
  const all = walk(join(ROOT, "benchmarks", "results"), (p) => /cross-pair-.*\.json$/.test(p));
  all.sort((a, b) => statSync(b).mtimeMs - statSync(a).mtimeMs);
  if (all[0]) {
    try {
      const j = JSON.parse(readFileSync(all[0], "utf-8")) as { summary?: { passRateOnCorrect?: number; errors?: number; latencyMs?: { p50_total?: number } } };
      if (j.summary?.passRateOnCorrect != null) {
        return { source: relative(ROOT, all[0]), summary: { passRateOnCorrect: j.summary.passRateOnCorrect, errors: j.summary.errors ?? 0, latencyMs: j.summary.latencyMs } };
      }
    } catch {
      // ignore
    }
  }
  return null;
}

/** Latest wave label per CHANGELOG.md top-most heading. */
function latestWave(): string | null {
  const ch = readIfExists("CHANGELOG.md");
  if (!ch) return null;
  // Match "## [Wave 35d: …]" or "## [Wave 35 Track 1: …]"
  const m = ch.match(/^##\s*\[\s*Wave\s+([\d]+[a-z]?(?:\s*Track\s*\d+)?)/im);
  return m?.[1]?.replace(/\s+/g, " ").trim() ?? null;
}

// ─── Assertion: test count ──────────────────────────────────────────────────

function checkTestCountClaims(): void {
  const actual = countTestInvocations();
  const files = countTestFiles();
  // Pattern shape — `withFiles: true` means the regex captures (count, filesCount).
  // `withFiles: false` means only (count); file-count comparison is skipped.
  const targets: Array<{ path: string; patterns: Array<{ re: RegExp; withFiles: boolean }> }> = [
    { path: "README.md", patterns: [
      { re: /\*\*(\d{3})\s*\/\s*(\d{3})\*\*\s+passing/g, withFiles: false }, // "**761 / 761** passing"
      { re: /\*\*(\d{3})\s*\/\s*(\d{3})\*\*\s+vitest/g, withFiles: false },  // "**761 / 761** vitest"
      { re: /~?(\d{3})\s+tests\s+across\s+(\d{1,2})\s+files/g, withFiles: true },
    ] },
    { path: "CONTRIBUTING.md", patterns: [
      { re: /~(\d{3})\s+tests\s+across\s+(\d{1,2})\s+files/g, withFiles: true },
    ] },
    { path: "docs/ARCHITECTURE.md", patterns: [
      { re: /\b(\d{3})\s+in-process\s+tests\s+across\s+(\d{1,2})\s+files/g, withFiles: true },
    ] },
    { path: "docs/TEST-STRATEGY.md", patterns: [
      { re: /\b(\d{3})\s+across\s+(\d{1,2})\s+files/g, withFiles: true },
    ] },
  ];

  // Drift band: actual ± 10% counts as "fresh." Outside that band → error.
  const band = Math.max(20, Math.floor(actual * 0.1));
  for (const t of targets) {
    const src = readIfExists(t.path);
    if (!src) continue;
    const lines = src.split("\n");
    for (const p of t.patterns) {
      for (let i = 0; i < lines.length; i++) {
        for (const m of lines[i]!.matchAll(p.re)) {
          const claimed = Number(m[1]);
          if (Math.abs(claimed - actual) > band) {
            err(
              "test-count",
              t.path,
              `claims ${claimed} tests (matched: "${m[0]}")`,
              `actual ${actual} test invocations across ${files} files`,
              i + 1,
            );
          }
          // Only check the secondary capture as a "file count" when
          // the pattern was registered as `withFiles: true`. Otherwise
          // m[2] is just the right-hand side of "N / N" passing — same
          // number as m[1] by convention, not a file count.
          if (p.withFiles && m[2]) {
            const claimedFiles = Number(m[2]);
            if (Math.abs(claimedFiles - files) > 3) {
              err(
                "test-file-count",
                t.path,
                `claims ${claimedFiles} test files (matched: "${m[0]}")`,
                `actual ${files} test files`,
                i + 1,
              );
            }
          }
        }
      }
    }
  }
}

// ─── Assertion: pass-rate claim ─────────────────────────────────────────────

function checkPassRateClaims(): void {
  const bench = loadLatestBench();
  if (!bench) {
    warn("bench-source", "benchmarks/results/", "no bench JSON found to verify pass-rate claims against", "expected at least one cross-pair-*.json or wave35*/baseline-run1.json");
    return;
  }
  const truth = bench.summary.passRateOnCorrect * 100; // percent
  // Only check README. CHANGELOG is historical-by-design (every wave's
  // numbers go in there in order); flagging old wave entries as
  // "drift" is wrong. CHANGELOG entries SUPERSEDE — they don't bind
  // the current state.
  const targets = ["README.md"];
  for (const t of targets) {
    const src = readIfExists(t);
    if (!src) continue;
    const lines = src.split("\n");
    for (let i = 0; i < lines.length; i++) {
      // The line must literally say "pass-rate" (with optional dash/space)
      // AND not be a confidence-interval-upper-bound mention. We require
      // the percentage to appear WITHIN ~30 chars of the "pass-rate"
      // token to filter out e.g. README's "false-negative rate is ~5%
      // (Wilson 95% CI upper 10.2%, n=137)" line — the 10.2 is the CI
      // upper, not a pass-rate claim.
      const line = lines[i]!;
      // skip lines that look like CI / confidence-interval mentions
      if (/Wilson|CI\s*[a-z]*\s*(?:upper|lower|bound)|confidence\s*interval/i.test(line)) continue;
      const passRateIdx = line.search(/pass[-\s]?rate|passRate/i);
      if (passRateIdx < 0) continue;
      const re = /\b(\d{2}\.\d{1,2})\s*%/g;
      for (const m of line.matchAll(re)) {
        // Require the percent literal to be within 30 chars of the
        // "pass-rate" token. Avoids matching adjacent stats like "10.2%
        // CI upper" or "Cost: 0.25%" on the same line.
        const pctIdx = m.index ?? 0;
        if (Math.abs(pctIdx - passRateIdx) > 40) continue;
        const claim = Number(m[1]);
        // Allow ±5 pp drift before flagging.
        if (Math.abs(claim - truth) > 5) {
          warn(
            "pass-rate",
            t,
            `claims pass-rate ${claim}% near a "pass-rate" mention`,
            `latest bench (${bench.source}): ${truth.toFixed(2)}%`,
            i + 1,
          );
        }
      }
    }
  }
}

// ─── Assertion: file-path references in docs resolve ────────────────────────

function checkFilePathClaims(): void {
  const targets = ["README.md", "CHANGELOG.md", "CONTRIBUTING.md"];
  // Keywords that indicate the path is being referenced in a
  // "removed / renamed / deleted / trimmed" historical context.
  // When the line contains one of these the script does NOT require
  // the path to currently exist — historical records are allowed to
  // reference now-defunct files (that's the point of a changelog).
  // Match keywords (with word boundaries where applicable) OR the rename
  // arrow `→` (a non-word char, so the word-boundary lookahead doesn't
  // apply there — that's why the previous version of this regex missed
  // lines like `src/lib/foo.ts → src/lib/bar.ts`).
  const HISTORICAL_KEYWORDS = /(\bdeleted\b|\bremoved\b|\brenamed\b|\bdropped\b|\btrimmed\b|\breplaced\b|\bnever created\b|reference dropped|→|reference replaced|stripped references from)/i;
  for (const t of targets) {
    const src = readIfExists(t);
    if (!src) continue;
    const lines = src.split("\n");
    for (let i = 0; i < lines.length; i++) {
      // docs/ANYTHING.md or src/lib/whatever.ts etc.
      // Path regex: order alternatives longest-first so `tsx` is preferred
      // over `ts`. Without the ordering, `page.tsx` matches as `page.ts` +
      // leftover `x` and reports a phantom broken path. The trailing
      // word-boundary asserts we don't truncate the extension.
      const refs = [
        ...lines[i]!.matchAll(/`?(docs\/[A-Za-z0-9_-]+\.(?:md|yaml))`?(?![A-Za-z0-9])/g),
        ...lines[i]!.matchAll(/`?(src\/[A-Za-z0-9_/.-]+\.(?:tsx|ts))`?(?![A-Za-z0-9])/g),
        ...lines[i]!.matchAll(/`?(bin\/[A-Za-z0-9_-]+\.ts)`?(?![A-Za-z0-9])/g),
        ...lines[i]!.matchAll(/`?(benchmarks\/[A-Za-z0-9_/.-]+\.(?:md|json|ts))`?(?![A-Za-z0-9])/g),
      ];
      // Lines that describe a historical deletion / rename / drop
      // are allowed to reference now-defunct paths. The CHANGELOG
      // exists precisely to record those changes.
      const isHistorical = HISTORICAL_KEYWORDS.test(lines[i]!);
      // Two-line look-back catches multi-line "deleted X, ..." entries
      // where the path lands on the line after the deletion verb.
      const isHistoricalContext = isHistorical
        || (i > 0 && HISTORICAL_KEYWORDS.test(lines[i - 1]!))
        || (i > 1 && HISTORICAL_KEYWORDS.test(lines[i - 2]!));
      for (const m of refs) {
        const p = m[1]!;
        if (!existsSync(join(ROOT, p))) {
          if (isHistoricalContext) {
            // Allowed — historical record. Don't even warn; this is
            // expected for any project with a non-trivial CHANGELOG.
            continue;
          }
          err("broken-path", t, `references "${p}"`, "file does not exist", i + 1);
        }
      }
    }
  }
}

// ─── Assertion: GUI strings vs reality ─────────────────────────────────────

function checkGuiStringClaims(): void {
  // GUI strings that have hard-coded numeric claims. The wave-35c work
  // already replaced "in ~3 seconds" with the honest 4-6s, but a
  // regression here would be especially user-visible.
  const guiFiles = [
    "src/app/page.tsx",
    "src/app/layout.tsx",
    ...walk(join(ROOT, "src", "app", "components"), (p) => p.endsWith(".tsx")),
  ];
  // Track block-comment depth so JSDoc / inline doc blocks are skipped
  // for GUI string checks. A wave-N "we used to do X, fixed in wave-M"
  // comment inside a `/* ... */` should not register as a claim.
  for (const f of guiFiles) {
    const rel = relative(ROOT, f);
    const src = readFileSync(f, "utf-8");
    const lines = src.split("\n");
    let inBlockComment = false;
    for (let i = 0; i < lines.length; i++) {
      const line = lines[i]!;
      // Block-comment tracking. We approximate by scanning each line
      // for `/*` and `*/` markers; multi-marker lines are rare enough
      // in TSX that a per-line toggle is fine. JSX-comment syntax
      // (`{/* ... */}`) is also block-comment-shaped, so it's skipped
      // identically.
      const opensBlock = /\/\*/.test(line);
      const closesBlock = /\*\//.test(line);
      const isInsideBlock = inBlockComment || (opensBlock && !closesBlock) || /^\s*\*/.test(line);
      if (opensBlock && !closesBlock) inBlockComment = true;
      if (closesBlock) inBlockComment = false;
      // Single-line `//` comments are also non-runtime — skip.
      const stripped = line.replace(/\/\/.*$/, "");
      // If the line is purely inside a block comment OR was only the
      // comment portion, treat as documentation and skip the GUI
      // string checks below.
      if (isInsideBlock) continue;
      // The pre-wave-35c "verdict returns in ~3 seconds" copy must
      // never come back.
      if (/in ~?3 seconds?\b/.test(stripped)) {
        err("gui-stale-latency", rel, stripped.trim().slice(0, 100), "wave-35c set the honest range to ~4-6 s end-to-end on warm", i + 1);
      }
      // "under 5 seconds" is ALSO stale (wave-35c retraction)
      if (/under 5 seconds?\b/i.test(stripped)) {
        err("gui-stale-latency", rel, stripped.trim().slice(0, 100), "wave-35c retracted this; current copy is '~4-6 seconds end-to-end on a warm function'", i + 1);
      }
      // Concurrency claim — the wave-34 fix moved this to dynamic
      if (/concurrency 2\b/.test(stripped)) {
        err("gui-stale-concurrency", rel, stripped.trim().slice(0, 100), "wave-34 fixed this — server actually runs at 12; concurrency is dynamic now", i + 1);
      }
    }
  }
}

// ─── Assertion: CHANGELOG wave chain ───────────────────────────────────────

function checkChangelogWaveChain(): void {
  const ch = readIfExists("CHANGELOG.md");
  if (!ch) return;
  // Find every Wave header with its full text + the body until the next
  // `## ` header. We want the FIRST entry that actually shipped code —
  // skipping FALSIFIED entries and docs-only entries that don't bind
  // the README to mention them.
  const sections = ch.split(/(?=^##\s)/gm);
  let latestShipped: string | null = null;
  for (const s of sections) {
    const m = s.match(/^##\s*\[\s*Wave\s+([\d]+[a-z]?(?:\s*Track\s*\d+)?)[^\]]*\]/im);
    if (!m) continue;
    const headerLine = s.split("\n", 1)[0] ?? "";
    const firstFew = s.split("\n").slice(0, 30).join("\n");
    // Skip falsified / docs-only entries — they don't ship code.
    if (/FALSIFIED|docs[- ]only|No code change/i.test(headerLine + " " + firstFew)) {
      continue;
    }
    latestShipped = m[1] ?? null;
    break;
  }
  const readme = readIfExists("README.md");
  if (latestShipped && readme) {
    const haystack = readme.toLowerCase();
    const needles = [
      `wave ${latestShipped.toLowerCase()}`,
      `wave-${latestShipped.toLowerCase().replace(/\s+/g, "-")}`,
      // strip "track N" trailer for the bare wave-number check
      `wave ${latestShipped.split(/\s/)[0]?.toLowerCase()}`,
      `wave-${latestShipped.split(/\s/)[0]?.toLowerCase()}`,
    ];
    if (!needles.some((n) => n && haystack.includes(n))) {
      warn(
        "changelog-readme-sync",
        "README.md",
        `does not mention latest shipped wave "${latestShipped}"`,
        "README's verified-state section should reference the most-recent shipped wave when it ships code",
      );
    }
  }
}

// ─── Assertion: env vars in docs vs code ───────────────────────────────────

function checkEnvVarDocs(): void {
  // Collect env-var names that appear in `docs/DEPLOYMENT.md` (and similar).
  const deploy = readIfExists("docs/DEPLOYMENT.md");
  if (!deploy) return;
  const envVarPattern = /\b([A-Z][A-Z0-9_]{3,})\s*=/g;
  const mentioned = new Set<string>();
  for (const m of deploy.matchAll(envVarPattern)) {
    const name = m[1]!;
    if (name.startsWith("LV_") || name.startsWith("GEMINI_") || name.startsWith("OPENAI_") ||
        name.startsWith("MAX_") || name.startsWith("RATE_LIMIT_") || name === "GOOGLE_API_KEY" ||
        name === "DEBUG_TOKEN" || name === "MODEL_FALLBACK" || name === "SECOND_OPINION_PROVIDER" ||
        name === "INLINE_BATCH_CONCURRENCY" || name === "MAX_BATCH_SIZE") {
      mentioned.add(name);
    }
  }
  // For each, check it's actually referenced somewhere in src/ (so we
  // don't ship docs for an env var the code stopped reading).
  const codeFiles = walk(join(ROOT, "src"), (p) => /\.(ts|tsx)$/.test(p) && !p.includes("/tests/"));
  const codeBlob = codeFiles.map((f) => readFileSync(f, "utf-8")).join("\n");
  for (const name of mentioned) {
    if (!codeBlob.includes(name)) {
      warn("env-var-orphan", "docs/DEPLOYMENT.md", `mentions ${name}=… but no src/ file reads it`, `confirm the env var is still wired in code`);
    }
  }
}

// ─── Run + report ──────────────────────────────────────────────────────────

function main(): void {
  checkTestCountClaims();
  checkPassRateClaims();
  checkFilePathClaims();
  checkGuiStringClaims();
  checkChangelogWaveChain();
  checkEnvVarDocs();

  const errors = findings.filter((f) => f.severity === "error");
  const warnings = findings.filter((f) => f.severity === "warning");

  if (errors.length === 0 && warnings.length === 0) {
    console.log("✓ verify-claims: all claims consistent with current main.");
    process.exit(0);
  }

  if (warnings.length > 0) {
    console.log(`\n──── ${warnings.length} warning(s) ────`);
    for (const f of warnings) {
      const where = f.line ? `${f.file}:${f.line}` : f.file;
      console.log(`  [${f.category}] ${where}`);
      console.log(`    claim:    ${f.claim}`);
      console.log(`    expected: ${f.expected}`);
    }
  }

  if (errors.length > 0) {
    console.log(`\n──── ${errors.length} error(s) — DRIFT DETECTED ────`);
    for (const f of errors) {
      const where = f.line ? `${f.file}:${f.line}` : f.file;
      console.log(`  [${f.category}] ${where}`);
      console.log(`    claim:    ${f.claim}`);
      console.log(`    expected: ${f.expected}`);
    }
    console.log(`\n${errors.length} drift error(s). Update the file(s) above to match the canonical source, then re-run.`);
    process.exit(1);
  }

  console.log(`\n${warnings.length} warning(s) — non-blocking but worth a look.`);
  process.exit(0);
}

main();
