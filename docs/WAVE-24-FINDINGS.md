# Wave 24 — class_type generic-on-label vs specific-on-application (recover 3 false-fails)

> Recorded 2026-05-13. Cluster-B target from the wave-22 false-fail diagnosis. The 3 deterministic false-fails on AI-photo labels where the bottle prints just the generic class designation but the COLA application declares the specific subtype.

## 1. Hypothesis (pre-registered)

> When the LABEL canonicalizes to a recognised generic family name ("WINE", "BEER", "MALT BEVERAGE", "DISTILLED SPIRITS") and the DECLARED canonicalizes to (or contains) a known subtype of that family, the comparator should route to REVIEW (not FAIL). This is regulator-defensible — TTB class-of-fitness regs allow either form (27 CFR §4.32 wine, §7.22 malt beverages, §5.22 distilled spirits) — and recovers the 3 deterministic Cluster-B false-fails without introducing `false-pass-on-correct`.

Conservative landing at REVIEW (rather than PASS) preserves sharp rejection on the WRONG-GT perturbations of these images, which swap one subtype for another within the same family (Grenache → Cabernet Sauvignon, Lager → IPA). On the wrong-GT side, the verifier cannot distinguish a different-varietal mismatch from the label alone if the label only says "WINE" — but other perturbed fields (brand, ABV, etc.) still hold the rejection.

## 2. Acceptance criterion (regulator-critical, pre-registered)

`false-pass-on-correct` mean over N=3 runs must stay within baseline `mean + 2σ = 7.61`.

## 3. Implementation

| File | Change |
|---|---|
| `src/lib/matching/class.ts` | Added `GENERIC_CLASS_FAMILIES` table (wine / beer / distilled spirits / fortified wine → set of common subtypes). Added `GENERIC_CLASS_NAMES` set + `genericFamilyOf()` helper. New escalation branch in `compareClass` after the wave-16 substring path. |
| `src/tests/matching.test.ts` | 7 new tests pinning each Cluster-B case, cross-family rejection guard, unknown-subtype rejection guard, and case-insensitive matching. |

The matching uses token-substring of the declared canonical against family-subtype set members (4+ char minimum), so descriptive declared values like "Mango Lime Malt Seltzer" match the "malt seltzer" subtype without needing every flavor descriptor in the table.

## 4. Result (N=3 cross-pair bench)

Corpus: `test-data-combined` (170 × 2 = 340 tasks per run). Concurrency: 4.

### 4.1 Bucket counts (fully deterministic across N=3)

| Bucket | Baseline ±2σ (N=8) | wave-23 (N=3) | wave-24 (N=3) | Δ vs wave-23 | Verdict |
|---|---:|---:|---:|---:|---|
| true-pass | 39.3 ±14.0 | 38 | 38 | 0 | ≈ same |
| **false-fail** | **11.9 ±0.7** | 7 | **4** | **−3.0** | **↓ outside −2σ** (cumulative −7.9 vs baseline) |
| review-on-correct | 41.3 ±15.4 | 47 | 50 | +3.0 | ≈ same (Cluster B landed here) |
| **false-pass-on-correct** | **4.6 ±3.0** | 5 | **5** | 0 | ✓ **PASS** acceptance |
| true-fail | 72 | 72 | 72 | 0 | deterministic |
| error-on-correct | 1 | 1 | 1 | 0 | deterministic |
| true-reject | 164.3 ±3.1 | 168 | 168 | 0 | wave-22 inherited |
| review-on-wrong | 4.8 ±3.1 | 1 | 1 | 0 | wave-22 inherited |
| error-on-wrong | 1 | 1 | 1 | 0 | deterministic |

**Pre-registered acceptance criterion**: `false-pass-on-correct = 5.0` (mean, N=3) ≤ baseline upper 7.61. ✓ **PASS**.

`fail-or-review-rate-on-wrong = 100%` preserved across all 3 runs — the conservative REVIEW landing did not cost any wrong-GT rejection because other perturbed fields on those wrong-GT cases still drive the rejection.

### 4.2 Which cases recovered

Each of the 3 Cluster-B cases moved from `false-fail` → `review-on-correct`:

| Image | Declared | Label printed | Pre-wave-24 | Wave-24 |
|---|---|---|---|---|
| ai-label-0065.jpg | Grenache | WINE | FAIL (class_type fail) | REVIEW |
| ai-label-0076.jpg | Lager | BEER | FAIL (class_type fail) | REVIEW |
| ai-label-0080.jpg | Mango Lime Malt Seltzer | MALT BEVERAGE | FAIL (class_type fail) | REVIEW |

### 4.3 Remaining false-fails after wave-24

4 deterministic false-fails left:
- **ai-label-0031, ai-label-0050** — Cluster A residuals. Wave-23 fixed their text mismatch, but `size=review` still drives the verdict to REVIEW (not PASS). Same root cause as the wave-21 size-channel problem. Deferred.
- **deg-beer-0001, deg-spirits-0003** — Cluster C: `brand_name` or `class_type` not extracted from the label. Lower frequency. Wave-25 candidate (prompt refinement or stronger second-opinion arbitration on null fields).

### 4.4 Determinism

All 9 bucket counts identical across all 3 wave-24 replicates. Pass-rate-on-correct exactly 65.1% on every run. Same property wave-22 introduced.

### 4.5 Latency

p50 = 2.7 s mean, p95 = 12.0 s mean. No change vs wave-23 (the comparator change is microseconds).

## 5. Cumulative progress (waves 22 + 23 + 24)

| Bucket | Baseline (N=8 mean) | Wave-24 (N=3) | Δ |
|---|---:|---:|---:|
| true-pass | 39.3 | 38 | −1.3 |
| **false-fail** | **11.9** | **4** | **−7.9 (compliant labels saved from wrongful rejection)** |
| review-on-correct | 41.3 | 50 | +8.7 (friction, but safer) |
| **false-pass-on-correct** | **4.6** | **5** | **+0.4 (within noise)** |
| true-fail | 72 | 72 | 0 |
| error-on-correct | 1 | 1 | 0 |
| true-reject | 164.3 | 168 | +3.7 (sharper wrong-GT rejection) |
| review-on-wrong | 4.8 | 1 | −3.8 (paired with true-reject) |
| error-on-wrong | 1 | 1 | 0 |

Pass-rate-on-correct: 65.8% baseline → 65.1% wave-24 (within noise — the slight conservative tradeoff is from waves 23/24 moving some PASSes to REVIEW).

Determinism: baseline had ±10 pp swing on pass-rate-on-correct over N=8. Wave-24 is **exactly 65.1% on every run**. The federal reviewer sees the same verdict on the same image every time.

## 6. Conclusion

Wave-24 ships. Targeted intervention; predictable outcome; no acceptance-criterion violations.

- ✓ Pre-registered acceptance criterion met (fp-on-correct = 5, within 4.6 ±3.0 baseline ±2σ)
- ✓ 3 of 3 predicted Cluster-B false-fails recovered
- ✓ Determinism preserved (all 9 buckets identical across N=3)
- ✓ Latency unchanged
- ✓ Wrong-GT rejection preserved (fail-or-review-rate-on-wrong = 100%)

## 7. Next intervention priorities

1. **Cluster C (2 false-fails: `deg-beer-0001`, `deg-spirits-0003`)** — `brand_name` or `class_type` extracted as null. Lowest count; possibly worth a prompt-side fix or a second-opinion arbitration on null fields.
2. **Cluster A residuals (2 false-fails: `ai-label-0031`, `ai-label-0050`)** — text recovered by wave-23, but `size=review` still tanks the verdict. Same root cause as the wave-21 size-channel problem. Defer until a viable size-detection design surfaces.
3. **Synthetic B/S false-pass-on-correct (5 deterministic)** — same wave-21 size-channel problem from the other direction. Multi-signal voting may be the path; deferred until the signal sources mature.
4. **review-on-correct (50, up from 41.3 baseline)** — bigger UX lever now than before, since waves 23/24 moved compliant labels INTO review rather than failing them. Worth a future targeted-resolution pass once the regulator-critical buckets are stable.

References:
- `docs/WAVE-22-FINDINGS.md` — second-opinion model swap baseline
- `docs/WAVE-23-FINDINGS.md` — Gov-Warning text case-fold
- `docs/WAVE-13-FINDINGS.md` — N=6 noise-band methodology
- `docs/BENCH-PROTOCOL.md` — N≥3 + 2σ rule
