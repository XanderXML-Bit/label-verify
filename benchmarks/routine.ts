// Routine-test subset for LabelVerify.
//
// Why this file exists:
//   Running the full v2 corpus on every benchmark invocation is wasteful for
//   day-to-day iteration and outright expensive for CI when the vision
//   contenders are enabled (USD per call × N labels × M trials adds up fast).
//   The routine subset is a curated 15-label slice chosen to hit every
//   important axis of the corpus — beverage type, government-warning
//   non-compliance taxonomy, and degradation variants — with minimum
//   overlap. Running --routine gives a representative signal in seconds,
//   while the full corpus stays reserved for the formal bake-off.
//
// Why hand-curated, not sampled at runtime:
//   Reproducibility. The ID list is committed so a routine run in CI today
//   compares apples-to-apples with the same run last week. Random sampling
//   would let the signal drift between commits. See
//   ./routine-manifest equivalent at test-data-v2/routine-manifest.json
//   for the human-readable rationale ("why these 15").
//
// To change the set: update both ROUTINE_IDS *and* test-data-v2/routine-manifest.json
// in the same commit. The manifest is the audit trail; this file is what
// the runner reads.

import type { GroundTruth } from "./scorer";

/**
 * The 15 IDs that make up the routine subset. Order is not significant — the
 * benchmark runner re-sorts by id. See test-data-v2/routine-manifest.json
 * for the one-line "why this ID" rationale on each entry.
 *
 * Coverage axes (one line each so a reviewer can sanity-check at a glance):
 *   • 3 fully compliant (beer / wine / spirits) — baseline pass cases
 *   • 1 X1 — warning missing (the hardest-fail case)
 *   • 1 T1 — word substitution in the warning body
 *   • 1 C1 — title-case prefix (must be ALL CAPS)
 *   • 1 B1 — prefix not bold
 *   • 1 S2 — small container, prefix below the size minimum
 *   • 1 X3 — Spanish-only foreign-language warning (English missing)
 *   • 1 perspective-degraded compliant
 *   • 1 lowlight-degraded compliant
 *   • 1 occlusion-degraded compliant
 *   • 1 curved-degraded (also covers gov_warning_case=T4 incidentally)
 *   • 1 stylized-brand compliant (all-caps SALTGRASS)
 *   • 1 small-container compliant (100 ml wine — meets size minimum)
 */
export const ROUTINE_IDS: readonly string[] = [
  // Compliant baseline: beer / wine / spirits
  "syn-beer-0001",
  "syn-wine-0002",
  "syn-spirits-0001",
  // Government-warning non-compliance taxonomy
  "syn-beer-0019",            // X1 — missing entirely
  "syn-beer-0007",            // T1 — word substitution
  "syn-spirits-0010",         // C1 — title-case prefix
  "syn-beer-0014",            // B1 — prefix not bold
  "syn-beer-0017",            // S2 — below size minimum
  "syn-fortified_wine-0006",  // X3 — Spanish-only paraphrase, no English statement
  // Degradation variants (compliant content, optical noise)
  "deg-beer-0002",            // perspective:9deg
  "deg-wine-0002",            // lowlight:0.35
  "deg-beer-0001",            // occlusion:0.12
  "deg-beer-0013",            // curved:0.27 (incidentally also gov_warning_case=T4)
  // Edge cases that historically trip generic extractors
  "syn-spirits-0007",         // Stylized all-caps brand (SALTGRASS) — compliant
  "syn-wine-0001",            // 100 ml small container — compliant
] as const;

/**
 * Pick the routine subset from a loaded ground-truth corpus.
 *
 * Filters the input `truths` to only the IDs in {@link ROUTINE_IDS}. If any
 * expected ID is missing from the corpus the function logs a loud warning
 * (one line per missing ID) and continues with whatever matched — the
 * benchmark still produces a signal, just on a smaller slice. We warn rather
 * than throw because a partial run is more useful than no run; an empty
 * result on the other hand still surfaces (downstream `summarize()` reports
 * `n=0` per technique), so a fully broken manifest won't masquerade as a
 * pass.
 *
 * @param truths The full ground-truth list as loaded by `loadCorpus()`.
 * @returns The matched ground-truth records (length ≤ ROUTINE_IDS.length).
 */
export function selectRoutine(truths: GroundTruth[]): GroundTruth[] {
  const byId = new Map<string, GroundTruth>();
  for (const t of truths) byId.set(t.id, t);

  const matched: GroundTruth[] = [];
  const missing: string[] = [];
  for (const id of ROUTINE_IDS) {
    const gt = byId.get(id);
    if (gt) matched.push(gt);
    else missing.push(id);
  }

  if (missing.length > 0) {
    console.warn(
      `[bench] routine: ${missing.length} of ${ROUTINE_IDS.length} expected IDs ` +
        `are missing from the loaded corpus. Missing: ${missing.join(", ")}. ` +
        `Either the corpus was regenerated and IDs shifted (update benchmarks/routine.ts + ` +
        `test-data-v2/routine-manifest.json), or you pointed --corpus at a directory ` +
        `that does not contain these labels.`,
    );
  }

  return matched;
}
