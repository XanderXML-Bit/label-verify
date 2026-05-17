import { preprocessImage } from "./preprocess";
import { GeminiFlashExtractor } from "./vision/gemini";
import { tesseractEngine } from "./ocr/tesseract";
import {
  buildSecondOpinionExtractor,
  secondOpinionAvailable,
} from "./vision/second-opinion";

// Lazy-but-memoized loader for the OpenAI extractor module. Used by
// the cross-PROVIDER FALLBACK path (primary fails entirely → retry on
// OpenAI). NOT used by the second-opinion path anymore; that goes
// through buildSecondOpinionExtractor which defaults to Gemini 2.5
// Flash (wave-22, per user direction 2026-05-13).
//
// Previously re-imported on every borderline second-opinion + every
// fallback path — Node caches the module after the first call, but
// each `await import` still resolves a microtask. Cheap, but free is
// cheaper. Per Agent D code-quality audit 2026-05-13.
// `type OpenAiModule = typeof import("./vision/openai")` would
// trip @typescript-eslint/consistent-type-imports; declare a typed
// alias up front with a type-only import. The runtime import is the
// dynamic one below.
type OpenAiModule = typeof OpenAiModuleNS;
import type * as OpenAiModuleNS from "./vision/openai";
let _openaiModuleCache: Promise<OpenAiModule> | null = null;
function loadOpenAiModule(): Promise<OpenAiModule> {
  if (!_openaiModuleCache) {
    _openaiModuleCache = import("./vision/openai");
  }
  return _openaiModuleCache;
}
import {
  compareBrand,
  compareAbv,
  compareNetContents,
  compareProducer,
  compareCountry,
  compareClass,
} from "./matching";
import { validateGovernmentWarning } from "./validation/government-warning-validator";
import type {
  DeclaredFields,
  ImageQuality,
  SecondOpinion,
  Verdict,
  VerifyResponse,
  VerifyTrace,
} from "./types";
import type {
  ExtractedFields,
  Extractor,
  ExtractorContext,
  ExtractorResult,
  OcrWord,
} from "./vision/types";
import type { OcrResult } from "./ocr";

interface VerifyOptions {
  extractor?: Extractor;
  /** Hard wall-clock budget for the vision call in ms. */
  visionTimeoutMs?: number;
  /**
   * Override the default preprocessing behaviour. Used by tests that pass
   * tiny synthetic images and want to skip the wave-31j Lanczos upscale.
   * Production never sets this.
   */
  preprocessOpts?: { maxEdge?: number; enlarge?: boolean; autoContrast?: boolean };
  /**
   * External abort signal. When aborted (e.g. SSE client disconnect),
   * the per-item timeout controller is aborted too — stopping any
   * in-flight vision call so we don't keep billing after the user has
   * navigated away.
   */
  abortSignal?: AbortSignal;
  /**
   * Optional sink for a {@link VerifyTrace} describing this run. Invoked once
   * after the response is built. Default is no-op. Used by /api/debug/last to
   * populate the in-memory ring buffer; never affects the response.
   */
  recordTrace?: (trace: VerifyTrace) => void;
}

// Single production mode. No public/API-selectable modes: every verify and
// extract call uses the same Gemini Flash Lite primary path, with fallback only
// when the primary provider fails. Explicit `opts.extractor` and
// `opts.visionTimeoutMs` remain for tests and internal dependency injection.
const DEFAULT_VISION_TIMEOUT_MS = 60_000;
const PRODUCTION_MODE_ID = "default";

/**
 * Per-field confidence floor below which we defer to a human reviewer
 * rather than return PASS. Intelligence-first priority: if we can't be
 * certain, defer.
 *
 * Calibration history:
 *   - 2026-05-11: Started at 0.75 (mid of empirical dead zone).
 *   - 2026-05-12 (morning): User observed over-deferral — many "borderline"
 *     extractions turned out to be correct, so deferring them to
 *     a human costs more than the safety it bought. Dropped to 0.55.
 *   - 2026-05-12 (afternoon): Formal calibration against the 170-image
 *     combined corpus via `scripts/calibrate-review-threshold.ts`.
 *     Findings (.review/threshold-calibration-report.md):
 *       · 22 of 170 images have a base-PASS verdict (the others FAIL/REVIEW
 *         on a comparator before τ gets a chance to fire).
 *       · Of those 22: 16 are truly compliant, 6 have a wrong-PASS lurking
 *         (the comparator passed an incorrect extraction).
 *       · loss(τ) is FLAT at 30 (= 6 MWP × 5 weight, 0 FPD) across
 *         τ ∈ [0.30, 0.90]. The threshold doesn't fire for any of those
 *         6 wrong PASSes because the model was confidently wrong, not
 *         borderline wrong.
 *       · τ ≥ 0.91 adds 3 false-positive defers without catching any
 *         additional wrong PASSes — strict loss increase.
 *       · 0.55 is therefore on the Pareto plateau; no change.
 *     Catching the remaining 6 wrong PASSes needs a different
 *     intervention (second-opinion vision call, tighter comparator
 *     gating) — not a threshold tweak. Tracked in REMAINING-IMPROVEMENTS A8.
 *
 * Per-field comparators (ABV, net-contents, etc.) still apply their own
 * field-specific thresholds. This is a *second-layer* floor that catches
 * cases where the comparator returned PASS but the underlying extractor
 * confidence is borderline.
 */
export const REVIEW_CONFIDENCE_THRESHOLD = 0.55;

/** Pretty per-field labels for the `reviewReasons` strings. */
const FIELD_LABEL: Record<string, string> = {
  brand_name: "Brand name",
  class_type: "Class / type",
  abv_percent: "ABV",
  net_contents: "Net contents",
  producer: "Producer / address",
  country_of_origin: "Country of origin",
};

/**
 * Top-level verify orchestrator. Per ARCHITECTURE.md §3:
 *   1. preprocess
 *   2. OCR + vision in parallel; vision is invoked WITHOUT the OCR
 *      text (the C1 "OCR-as-hint" hypothesis was falsified in the
 *      bake-off — see docs/MODEL-SELECTION.md §4.3). OCR's only
 *      role today is to feed the classical-CV stroke-width bold +
 *      type-size subscores on the Government Warning validator.
 *   3. match per-field
 *   4. validate the Government Warning
 *   5. aggregate verdict + image-quality
 */
export async function verifyLabel(
  imageBytes: Buffer,
  declared: DeclaredFields,
  opts: VerifyOptions = {},
): Promise<VerifyResponse> {
  const startTotal = performance.now();
  const visionTimeoutMs = opts.visionTimeoutMs ?? DEFAULT_VISION_TIMEOUT_MS;

  // ─── 1. Preprocess ───────────────────────────────────────────────────────
  const preStart = performance.now();
  const pre = await preprocessImage(imageBytes, opts.preprocessOpts);
  const preElapsed = performance.now() - preStart;

  // ─── 2. OCR + vision in parallel ─────────────────────────────────────────
  // Separate controllers for OCR vs the vision call. The vision call has
  // a per-mode budget that can fire ctrl.abort() mid-OCR; if we shared
  // one controller, every primary-vision-timeout would also kill OCR,
  // leaving the Gov-Warning validator on the fallback path with only
  // vision-self-reported flags (unreliable). Separate signals let OCR
  // keep running independently and arrive in time for the GW validator's
  // bold/size subscores. Per code-review B2.
  const ctrl = new AbortController();
  const ocrCtrl = new AbortController();
  const timeoutHandle = setTimeout(() => ctrl.abort(), visionTimeoutMs);
  // OCR gets a slightly longer budget than vision — Tesseract on a cold
  // worker has been known to spike to ~5 s, and we'd rather have OCR
  // finish for the GW validator than abort it in lockstep with vision.
  const ocrTimeoutHandle = setTimeout(
    () => ocrCtrl.abort(),
    Math.max(visionTimeoutMs, 10_000),
  );
  // Forward an external signal (e.g. SSE-client disconnect) into BOTH
  // controllers so a navigate-away stops every in-flight call.
  const externalAbort = opts.abortSignal;
  const onExternalAbort = () => {
    ctrl.abort();
    ocrCtrl.abort();
  };
  if (externalAbort) {
    if (externalAbort.aborted) onExternalAbort();
    else externalAbort.addEventListener("abort", onExternalAbort, { once: true });
  }

  const modeUsed = PRODUCTION_MODE_ID;
  const extractor = opts.extractor ?? buildDefaultExtractor();

  // OCR runs in parallel — its WORDS (bboxes) feed the Gov-Warning
  // bold/size subscores. Its TEXT is intentionally NOT fed to the
  // vision call (C1 was falsified — see comment block below).
  let ocrWords: OcrWord[] | undefined;
  let ocrElapsed: number | null = null;

  const ocrPromise: Promise<OcrResult | null> = tesseractEngine
    .run(pre.buffer, ocrCtrl.signal)
    .then((r) => {
      ocrWords = r.words;
      ocrElapsed = r.latencyMs;
      return r;
    })
    .catch(() => null);

  // OCR runs in parallel with the vision call but its text is NOT
  // injected into the vision prompt — the C1 "OCR-as-hint" hypothesis
  // was falsified in the bake-off (text fed in lowered accuracy on
  // stylised fonts). OCR's only role is to supply pixel-tight word
  // bboxes for the Government Warning bold + size subscores below.
  // Per code-review Hermes CRITICAL #1.

  const visionCtx: ExtractorContext = {
    // ocrText intentionally omitted — see comment above.
    ocrWords,
    signal: ctrl.signal,
  };

  let extracted: ExtractorResult;
  let fallbackUsed: string | null = null;
  try {
    try {
      extracted = await extractor.extract(pre.buffer, visionCtx);
    } catch (primaryErr) {
      // Primary vision provider is unreachable / 5xx / rate-limited /
      // timed out. Try a cross-provider fallback (GPT-5.4-nano via the
      // OpenAI SDK) if its key is wired. The fallback runs against the
      // SAME image and prompt, so the response shape is identical and
      // the rest of the pipeline doesn't know the difference — except
      // for the `fallbackUsed` flag we surface on the response so the
      // UI can render a "verified via backup" banner.
      const fallbackKey = process.env.OPENAI_API_KEY;
      const fallbackModel = process.env.MODEL_FALLBACK ?? "gpt-5.4-nano";
      if (!fallbackKey) {
        throw primaryErr;
      }
      // SECURITY: if the EXTERNAL caller already aborted (e.g. SSE
      // client disconnect mid-primary call), skip the fallback — we
      // would otherwise burn a fresh vision call (~$0.001) and up to
      // 25 s of compute on a request the user has already abandoned.
      // Code-review B3.
      if (externalAbort?.aborted) {
        throw primaryErr;
      }
      // SECURITY: don't reuse the primary controller's signal — it has
      // probably already aborted (which is why the primary call threw).
      // Reusing it would either short-circuit the fallback to an
      // immediate AbortError OR let the fallback run unbounded
      // depending on the SDK. Allocate a fresh controller with the
      // remaining budget (capped at 25s so we stay under the Vercel
      // Hobby 30s function timeout even when the primary burned most
      // of the original budget). 2026-05-12 security audit finding #4.
      const remainingMs = Math.min(
        25_000,
        Math.max(5_000, visionTimeoutMs - (performance.now() - startTotal)),
      );
      const fbCtrl = new AbortController();
      const fbTimer = setTimeout(() => fbCtrl.abort(), remainingMs);
      // Also forward an external abort into the fallback controller so a
      // disconnect mid-fallback also stops billing.
      const onExternalAbortFb = () => fbCtrl.abort();
      if (externalAbort && !externalAbort.aborted) {
        externalAbort.addEventListener("abort", onExternalAbortFb, { once: true });
      }
      const fallbackCtx: ExtractorContext = {
        // ocrText intentionally omitted — same C1-falsified rationale
        // as the primary call. ocrWords still feeds the GW validator
        // below.
        ocrWords,
        signal: fbCtrl.signal,
      };
      try {
        const mod = await loadOpenAiModule();
        const fallbackExtractor = new mod.GPT4oMiniExtractor({
          apiKey: fallbackKey,
          modelVersion: fallbackModel,
        });
        extracted = await fallbackExtractor.extract(pre.buffer, fallbackCtx);
        fallbackUsed = fallbackModel;
      } catch {
        // Both providers failed. Surface the primary error — it's more
        // diagnostic than the fallback (the user can fix the primary,
        // the fallback is best-effort).
        throw primaryErr;
      } finally {
        clearTimeout(fbTimer);
        if (externalAbort) {
          externalAbort.removeEventListener("abort", onExternalAbortFb);
        }
      }
    }
  } finally {
    clearTimeout(timeoutHandle);
    // Don't clear ocrTimeoutHandle here — OCR is still in flight for the
    // Gov-Warning validator's race below (the 8 s GW await on
    // ocrPromise). We clear it once we've used the OCR result.
    if (externalAbort) {
      externalAbort.removeEventListener("abort", onExternalAbort);
    }
  }

  // ─── 3. Match per-field ──────────────────────────────────────────────────
  const matchStart = performance.now();
  const f = extracted.fields;
  const brand = compareBrand(declared.brand_name, f.brand_name.value);
  const cls = compareClass(declared.class_type, f.class_type.value, f.class_type.confidence);
  const abv = compareAbv(
    declared.abv_percent,
    declared.class_category,
    f.abv_percent.value,
    f.abv_percent.confidence,
  );
  const nc = compareNetContents(
    declared.net_contents,
    f.net_contents.value,
    f.net_contents.confidence,
  );
  const producer = compareProducer(
    declared.producer,
    f.producer.value,
    f.producer.confidence,
  );
  const country = compareCountry(
    declared.country_of_origin,
    f.country_of_origin.value,
    f.country_of_origin.confidence,
  );

  // ─── 4. Government Warning ───────────────────────────────────────────────
  // Wait for OCR to finish before validating: if it succeeded, the validator
  // uses Tesseract word bboxes (pixel-tight) for the bold + size subscores
  // instead of the vision model's noisy self-reported `prefix_bbox`.
  // Bounded await: if Tesseract's still running well past the vision
  // call, we'd rather ship a vision-only Gov-Warning verdict than hang
  // until the function timeout (Vercel Hobby caps at 30s). 8s is plenty
  // for a fully warm worker to finish recognising a single label; a
  // cold worker that hasn't finished by then almost certainly won't in
  // the remaining budget. The .catch(()=>null) in ocrPromise's
  // construction makes the timeout-loser harmless to the rest of the
  // pipeline. See Vercel-deploy postmortem 2026-05-12.
  //
  // Wave-33 audit (Sub-agent A bug #18): hoist the inner setTimeout
  // to a named handle so we clear it when OCR wins the race; otherwise
  // a hot serverless worker accumulates one no-op timer per call.
  let ocrRaceTimer: ReturnType<typeof setTimeout> | null = null;
  const ocrFinal = await Promise.race([
    ocrPromise,
    new Promise<null>((resolve) => {
      ocrRaceTimer = setTimeout(() => resolve(null), 8_000);
    }),
  ]);
  if (ocrRaceTimer) clearTimeout(ocrRaceTimer);
  // OCR has either landed or the 8 s race timed out — either way the
  // OCR controller's wall-clock is no longer needed.
  clearTimeout(ocrTimeoutHandle);
  const gov = await validateGovernmentWarning({
    extracted: f.government_warning.value ?? {
      raw_text: null,
      prefix_text: null,
      prefix_bbox: null,
      prefix_appears_bold: null,
      prefix_appears_caps: null,
    },
    declaredNetContents: declared.net_contents,
    imageDimsPx: { width: pre.width, height: pre.height },
    ocrContext:
      ocrFinal && ocrFinal.words.length > 0
        ? { words: ocrFinal.words, imageBuffer: pre.buffer }
        : undefined,
  });
  const matchElapsed = performance.now() - matchStart;

  // ─── 5. Aggregate verdict + image quality ────────────────────────────────
  // Cross-link two independent country checks: `compareCountry`
  // (standalone country_of_origin field) and `compareProducer`'s
  // country sub-component (which can imply USA from a US-state +
  // corroborating-city pair on the address). If the producer
  // comparator's country component PASSED via implicit-USA inference
  // — i.e. the address conclusively shows a US producer — then the
  // standalone country REVIEW ("label doesn't print a country") is
  // redundant friction: we already proved domestic. Promote it to
  // PASS so the demo's PASS sample (US-domestic label with no
  // visible country marking) doesn't surprise-route to REVIEW.
  // Per UI re-audit 2026-05-12.
  let countryResolved = country;
  if (
    country.status === "review" &&
    producer.components?.country === "pass" &&
    typeof declared.producer !== "string" &&
    declared.producer.country
  ) {
    countryResolved = {
      ...country,
      status: "pass",
      confidence: Math.max(country.confidence, 0.7),
      reason:
        "Label does not visibly print a country of origin, but the printed producer address (US state + matching city/postal) corroborates the declared US country. Per 27 CFR §4.39 / §5.36, country marking is required only for imports.",
    };
  }
  const fieldResults = [brand, cls, abv, nc, producer, countryResolved];

  // VERDICT (compliance): worst field status + Gov Warning subscore.
  let verdict: Verdict = aggregateVerdict([
    ...fieldResults.map((r) => r.status),
    gov.status,
  ]);

  // ─── 5a. Intelligence-first deferral ─────────────────────────────────────
  //
  // Catch the case where every field comparator returned PASS individually
  // but the underlying extractor confidence is borderline on one or more
  // fields. Per the product priority: never return PASS when any field is
  // borderline; route borderline cases to a human-review queue.
  //
  // FAIL is never downgraded to REVIEW — a clearly non-compliant label still
  // fails, regardless of confidence. Only PASS is at risk of being too
  // optimistic.
  // NOTE: loop variable renamed from `f` to `cmp` so it doesn't shadow
  // the outer `const f = extracted.fields` reference further down. Per
  // code review finding #12 — the shadowing was a maintainability
  // landmine even though TypeScript's block scoping happened to keep
  // current call sites correct.
  const reviewReasons: string[] = [];
  for (const cmp of fieldResults) {
    if (
      cmp.status === "pass" &&
      cmp.confidence < REVIEW_CONFIDENCE_THRESHOLD
    ) {
      const label = FIELD_LABEL[cmp.field] ?? cmp.field;
      reviewReasons.push(
        `${label} confidence ${cmp.confidence.toFixed(2)} below ${REVIEW_CONFIDENCE_THRESHOLD} — extractor could not confidently read this field from the label.`,
      );
    }
  }
  // The Government Warning validator already returns REVIEW on borderline
  // bold; collect a human-readable reason when it does.
  if (gov.status === "review") {
    reviewReasons.push(
      `Government Warning subscore is REVIEW${gov.reason ? ` — ${gov.reason}` : ""}.`,
    );
  }
  // Bold-subscore-only confidence-floor signal.
  //
  // The bold subscore can take a fallback path where the only evidence
  // is the vision model's self-reported `prefix_appears_bold` flag —
  // OCR couldn't locate the prefix bbox, no font-bold signal — and the
  // validator returns `{ status: "pass", confidence: 0.6 }` (the
  // line-321 fallback in government-warning-validator.ts). On the
  // cross-pair bench this exact branch produced 4 of 5 Type I false-
  // positives (the model self-reports "bold" on a not-bold prefix
  // and the validator has no pixel measurement to disagree).
  //
  // Action is NOT to blanket-REVIEW (that over-routes ~15 compliant
  // labels per ~33 PASS results, which is operator-prohibitive at
  // 150 k apps/yr). Instead, treat this exact branch as the second-
  // opinion trigger: temporarily mark GW as REVIEW so the existing
  // cross-provider call fires; afterwards, if the second model agrees
  // with the primary's bold-pass, restore PASS. The agreement of two
  // independent vision models without pixel corroboration is a much
  // stronger signal than one model's self-report alone.
  //
  // See REMAINING-IMPROVEMENTS.md for the corresponding size-subscore
  // borderline-measurement case (~1 of the 5 Type I errors), which
  // has a different mechanism (OCR found the prefix but it's just
  // over the 0.8×min threshold) and is handled separately.
  const boldFallbackOnlyPass =
    gov.status === "pass" &&
    gov.subscores.bold.status === "pass" &&
    gov.subscores.bold.confidence === 0.6;
  // Wave-33 audit (Sub-agent A bug #13) trialled a symmetric
  // `sizeFallbackPass` predicate that would route the size-subscore
  // degraded-PASS band (confidence 0.4) through the same second-
  // opinion call the bold-fallback path uses. The regression bench
  // flagged this as flipping `syn-beer-0016` (B3 adversarial) from
  // review-on-correct to false-pass-on-correct — a hard-guardrail
  // violation. The asymmetry stays: bold-fallback fires the SO
  // because the bold subscore is the wave-28b-known weak signal on
  // synthetic adversarials, but the size subscore's degraded band
  // was empirically calibrated to NOT need extra corroboration.
  // Tracked for a future wave that adjusts the size-band threshold
  // (not the second-opinion trigger).
  // Per-field comparators that already returned REVIEW (e.g. ABV with low
  // extractor confidence, brand near-miss) also contribute a reason so the
  // reviewer sees the full picture in one place.
  for (const cmp of fieldResults) {
    if (cmp.status === "review") {
      const label = FIELD_LABEL[cmp.field] ?? cmp.field;
      reviewReasons.push(
        `${label} returned REVIEW${cmp.reason ? ` — ${cmp.reason}` : ""}`,
      );
    }
  }

  if (verdict === "pass" && reviewReasons.length > 0) {
    // Downgrade PASS → REVIEW. The reasons array is already populated.
    verdict = "review";
  }

  // IMAGE QUALITY (independent of compliance verdict).
  //
  // 2026-05-13 fix: use the EXTRACTOR's per-field confidence on fields
  // the model actually READ (value !== null) — not the comparator's
  // confidence. The previous comparator-based formula conflated two
  // things: (a) "the model couldn't read this clearly off the image"
  // (real image-quality concern) and (b) "the declared value the user
  // typed doesn't match what the model read" (manifest mismatch, has
  // nothing to do with image quality). A reviewer who submits a clean
  // photo with an intentionally-wrong declared value should see
  // image-quality = "good" + verdict = "fail/review" — not
  // "Re-photograph" on a perfectly legible label.
  //
  // The earlier worry (legitimately-absent country_of_origin tanking
  // the mean) is now handled by the `.value !== null` filter: the
  // extractor returns `{ value: null, confidence: 0 }` for fields not
  // printed on the label, and those are excluded from the average.
  // Fields that ARE printed contribute their honest extractor
  // confidence.
  const extractorConfidences = [
    extracted.fields.brand_name,
    extracted.fields.class_type,
    extracted.fields.abv_percent,
    extracted.fields.net_contents,
    extracted.fields.producer,
    extracted.fields.country_of_origin,
    extracted.fields.government_warning,
  ]
    .filter((f) => f.value !== null && f.value !== undefined)
    .map((f) => f.confidence);
  const meanConf =
    extractorConfidences.length > 0
      ? extractorConfidences.reduce((s, x) => s + x, 0) / extractorConfidences.length
      : 0;
  const minConf =
    extractorConfidences.length > 0 ? Math.min(...extractorConfidences) : 0;
  const imageQuality: ImageQuality =
    extractorConfidences.length === 0
      ? "bad"
      : minConf < 0.3
        ? "bad"
        : meanConf < 0.6
          ? "low"
          : "good";
  const imageQualityReason =
    imageQuality === "good"
      ? undefined
      : extractorConfidences.length === 0
        ? "The extractor could not read any fields from the image — re-photograph in better light at a sharper angle."
        : `Mean extractor confidence ${meanConf.toFixed(2)} (min ${minConf.toFixed(2)}) across ${extractorConfidences.length} fields the model could read.`;

  // ─── 5b. Unreadable-image safety net ─────────────────────────────────────
  //
  // If the image is too degraded for the extractor to confidently read
  // anything (image_quality === "bad"), the verdict should not be FAIL —
  // a corrupt/blurred/dark photo of a perfectly-compliant label would
  // otherwise be marked non-compliant. The product-correct routing for
  // these is REVIEW with a clear "re-photograph" reason: the reviewer
  // needs a usable image before any compliance determination can be
  // made. FAIL stays reserved for "label is visibly non-compliant on a
  // photo we can actually read."
  //
  // This deliberately UPGRADES FAIL → REVIEW when image quality is bad.
  // It does NOT downgrade PASS → REVIEW (a high-quality image that
  // passes is still a PASS — `imageQuality === "bad"` requires
  // minConf < 0.3, which implies the comparators did NOT pass at high
  // confidence anyway).
  if (imageQuality === "bad" && verdict === "fail") {
    verdict = "review";
    reviewReasons.unshift(
      `Image quality is too poor for a compliance determination (mean extractor confidence ${meanConf.toFixed(2)}, min ${minConf.toFixed(2)}). The label may be perfectly compliant — re-photograph in better light, at a sharper angle, and resubmit before treating this as non-compliance.`,
    );
  }

  // ─── 5c. Null-extraction safety net (wave-25, 2026-05-13) ────────────────
  //
  // Sister-safety-net to §5b. When the extractor returns `null` on a
  // *mandatory* COLA field (brand_name, class_type) — typically because
  // the relevant region of the label is obscured/cropped/illegible —
  // the comparator emits a status="fail" with confidence ≤ 0.05 and a
  // "No <field> found on the label" reason. The aggregate verdict
  // becomes FAIL even though the verifier hasn't actually proven non-
  // compliance — it just hasn't proven compliance either.
  //
  // The §5b net misses this case because `imageQuality === "bad"` is
  // computed only over fields the model COULD read (we explicitly
  // filter null values out so legitimate-absence cases like country
  // on US-domestic labels don't tank quality). So a label with a
  // partially-occluded brand or class region that the model reads
  // CONFIDENTLY null still gets `imageQuality === "good"` and falls
  // through to FAIL.
  //
  // Wave-25 catches the gap: if the only failing comparator(s) returned
  // their null-extraction sentinel (status=fail + confidence ≤ 0.05),
  // upgrade FAIL → REVIEW with a "couldn't read X from label" reason.
  // The reviewer can see the label themselves and confirm whether the
  // missing field is truly missing (regulatory issue) or merely
  // obscured in the submitted photo (re-shoot needed).
  //
  // Risk-bounded:
  //   • Never downgrades a PASS (the upgrade is FAIL → REVIEW only).
  //   • Never overrides a FAIL where the comparator had real content
  //     to compare (extractor returned a non-null value that didn't
  //     match) — those still FAIL because the gate is "fail at conf
  //     ≤ 0.05" which is the null-sentinel pattern.
  //   • The reviewer is more or less guaranteed to look at this label
  //     anyway because brand/class is missing from the verifier's
  //     output, so the REVIEW landing matches expected operator
  //     behavior.
  //
  // Recovers the 2 deterministic Cluster-C false-fails:
  //   deg-beer-0001 (class_type null on a partially-degraded label)
  //   deg-spirits-0003 (brand_name + class_type both unreadable due
  //                     to an oval occluding the front-label region)
  if (verdict === "fail") {
    const nullExtractionFields = fieldResults.filter(
      (cmp) => cmp.status === "fail" && cmp.confidence <= 0.05,
    );
    const otherFailures = fieldResults.filter(
      (cmp) => cmp.status === "fail" && cmp.confidence > 0.05,
    );
    if (nullExtractionFields.length > 0 && otherFailures.length === 0 && gov.status !== "fail") {
      verdict = "review";
      const labels = nullExtractionFields
        .map((cmp) => FIELD_LABEL[cmp.field] ?? cmp.field)
        .join(", ");
      reviewReasons.unshift(
        `The extractor could not read ${labels} from the submitted image. The label may be perfectly compliant — re-photograph the obscured region(s) or confirm visually before treating this as non-compliance.`,
      );
    }
  }

  // ─── 6. Independent second-opinion on borderline Gov-Warning ──────────────
  //
  // When the primary call lands on REVIEW for the Gov-Warning (either an
  // explicit `status: "review"` from the validator, or a low-confidence
  // PASS without OCR corroboration which §5a above downgraded to REVIEW),
  // fire a single second-opinion vision call against the cross-provider
  // fallback model (typically GPT-5.4-nano via OpenAI). The reviewer is
  // going to look at this label anyway — an independent second read gives
  // them more signal than just the primary's REVIEW verdict alone.
  //
  // Cost: ~$0.001 per fired call (5–10% of total volume, since most
  // verifications resolve cleanly). Latency: capped at 15 s. Safety:
  // wrapped in try/catch so a second-opinion failure never breaks the
  // primary response. Skipped when the primary already used the fallback
  // (no provider diversity gained from re-running the same backup).
  let secondOpinion: SecondOpinion | null = null;
  const govReviewBorderline =
    gov.status === "review" ||
    (gov.status === "pass" &&
      ocrFinal === null &&
      gov.confidence < REVIEW_CONFIDENCE_THRESHOLD) ||
    // Bold-fallback-only PASS: model self-reported bold with no pixel
    // corroboration. Fire a second-opinion call to corroborate or
    // refute. Post-process below restores PASS on agreement.
    boldFallbackOnlyPass;
  // (Wave-33 audit Sub-agent A bug #13 trialled also routing
  // size-fallback degraded-PASS through second-opinion symmetrically
  // with the bold path; the regression bench caught that doing so
  // changed `syn-beer-0016` from review to false-pass on-correct
  // — a hard-guardrail violation. Reverted. The asymmetry is
  // documented in the predicate above. Tracked for a future wave.)
  if (
    govReviewBorderline &&
    !fallbackUsed &&
    secondOpinionAvailable(process.env) &&
    !externalAbort?.aborted
  ) {
    const soStart = performance.now();
    const soReason =
      gov.status === "review"
        ? `Primary Gov-Warning subscore returned REVIEW${gov.reason ? ` — ${gov.reason}` : ""}`
        : `Primary Gov-Warning returned PASS at confidence ${gov.confidence.toFixed(2)} without OCR corroboration`;
    const soCtrl = new AbortController();
    const soTimer = setTimeout(() => soCtrl.abort(), 15_000);
    const onExternalAbortSo = () => soCtrl.abort();
    if (externalAbort) {
      externalAbort.addEventListener("abort", onExternalAbortSo, { once: true });
    }
    try {
      // Wave-22: default to Gemini 2.5 Flash (smarter than primary
      // Flash-Lite, same price tier). Falls back to OpenAI nano if
      // SECOND_OPINION_PROVIDER=openai or GOOGLE_API_KEY is missing.
      const soExtractor = await buildSecondOpinionExtractor(process.env);
      if (!soExtractor) {
        // Shouldn't happen — secondOpinionAvailable() returned true above.
        // Defensive: skip the call rather than throw.
        throw new Error("second-opinion extractor unavailable");
      }
      const soResult = await soExtractor.extract(pre.buffer, {
        ocrWords,
        signal: soCtrl.signal,
      });
      // Re-validate the GW from the second extractor's read of the
      // label, using the same OCR context the primary had so the two
      // verdicts are comparable.
      const soGw = soResult.fields.government_warning.value ?? {
        raw_text: null,
        prefix_text: null,
        prefix_bbox: null,
        prefix_appears_bold: null,
        prefix_appears_caps: null,
      };
      const soGov = await validateGovernmentWarning({
        extracted: soGw,
        declaredNetContents: declared.net_contents,
        imageDimsPx: { width: pre.width, height: pre.height },
        ocrContext:
          ocrFinal && ocrFinal.words.length > 0
            ? { words: ocrFinal.words, imageBuffer: pre.buffer }
            : undefined,
      });
      secondOpinion = {
        modelId: soResult.modelId,
        governmentWarning: soGov,
        agreesWithPrimary: soGov.status === gov.status,
        reason: soReason,
        latencyMs: round(performance.now() - soStart),
      };
    } catch {
      // Best-effort: a failed second-opinion call does NOT degrade
      // the primary verdict. Silent (no console noise on user-driven
      // aborts). The primary REVIEW + reviewReasons already signal
      // human-review needed.
    } finally {
      clearTimeout(soTimer);
      if (externalAbort) {
        externalAbort.removeEventListener("abort", onExternalAbortSo);
      }
    }
  }

  // Post-second-opinion: resolve the bold-fallback-only PASS case.
  //
  // If the trigger was the narrow bold-fallback-only predicate
  // (primary GW = PASS, but bold subscore only carried the model's
  // self-report), the second-opinion call's bold verdict is the
  // tie-breaker:
  //   - second-opinion bold = "pass" → both vision models agree
  //     the prefix is bold; restore the primary's PASS. Independent
  //     cross-provider agreement without pixel measurement is a
  //     stronger signal than one model's self-report.
  //   - second-opinion bold = "fail" or "review" → models disagree;
  //     keep verdict = REVIEW with a disagreement reason. UI's ⚖
  //     panel renders this.
  //   - second-opinion call failed entirely (network, timeout) →
  //     stay PASS (no signal to override). Documented as best-effort.
  if (boldFallbackOnlyPass && secondOpinion) {
    const soBold = secondOpinion.governmentWarning.subscores.bold.status;
    if (soBold === "pass") {
      // Two-model agreement on bold-pass. Restore PASS verdict.
      // No review reason added — the orchestrator's safety net cleared.
    } else {
      // Disagreement. Stay REVIEW.
      verdict = "review";
      reviewReasons.push(
        `Government Warning bold subscore: primary model self-reported bold (no OCR pixel measurement), but second-opinion ${secondOpinion.modelId} ${soBold === "fail" ? "disagrees and reports the prefix is not bold" : "is also uncertain"}. A human reviewer should confirm.`,
      );
    }
  }
  // (Wave-33 size-fallback second-opinion symmetric handling was
  // trialled and reverted — see the comment above `boldFallbackOnlyPass`.)

  const totalMs = performance.now() - startTotal;

  const response: VerifyResponse = {
    verdict,
    imageQuality,
    fields: {
      brand_name: brand,
      class_type: cls,
      abv_percent: abv,
      net_contents: nc,
      producer,
      country_of_origin: countryResolved,
    },
    governmentWarning: gov,
    extracted: f,
    timings: {
      preprocess: round(preElapsed),
      ocr: ocrElapsed === null ? null : round(ocrElapsed),
      vision: round(extracted.latencyMs),
      matching: round(matchElapsed),
      total: round(totalMs),
    },
    modelId: extracted.modelId,
    modelVersion: extracted.modelVersion,
    modeUsed,
    requiresHumanReview: verdict === "review",
    reviewReasons: verdict === "review" ? reviewReasons : [],
    ...(imageQualityReason ? { imageQualityReason } : {}),
    ...(fallbackUsed ? { fallbackUsed } : {}),
    ...(secondOpinion ? { secondOpinion } : {}),
  };

  // Hand the trace to the optional sink (used by /api/debug/last). Wrapped
  // in try/catch so an instrumentation bug can never break a real verify.
  if (opts.recordTrace) {
    try {
      opts.recordTrace({
        id: makeTraceId(),
        receivedAt: Date.now(),
        declared,
        preprocessedDims: { w: pre.width, h: pre.height },
        modelId: extracted.modelId,
        modelVersion: extracted.modelVersion,
        promptHash: extracted.promptHash,
        // OCR text is captured here for the debug trace (operators
        // grep it when triaging). It is NOT fed to the vision prompt
        // — the C1 OCR-as-hint hypothesis was falsified in the
        // bake-off, see comments earlier in this function.
        ocrText: ocrFinal?.text ?? null,
        rawExtraction: extracted.rawOutput,
        response,
      });
    } catch {
      // Swallow — debug instrumentation must never affect the response.
    }
  }

  return response;
}

// ─── extractOnly — application-data-free path ──────────────────────────────
//
// Same preprocess + OCR + vision pipeline as verifyLabel(), but stops
// after extraction. Used by /api/extract for the "show me what's on the
// label without an application" UX (per user direction 2026-05-11). We
// still surface modeId/modelVersion/timings so the result panel can
// render the same diagnostics block, and we still compute the
// image-quality flag so the reviewer sees the confidence pulse — there
// is just no PASS/FAIL/REVIEW verdict because we have nothing to
// compare against.

export interface ExtractOnlyResponse {
  extracted: ExtractedFields;
  imageQuality: ImageQuality;
  imageQualityReason?: string;
  governmentWarning: VerifyResponse["governmentWarning"];
  timings: {
    preprocess: number;
    ocr: number | null;
    vision: number;
    matching: number;
    total: number;
  };
  modelId: string;
  modelVersion: string;
  modeUsed: string;
  fallbackUsed?: string;
  /** Always present: tells the UI to show the no-application banner. */
  note: string;
}

export async function extractOnly(
  imageBytes: Buffer,
  opts: VerifyOptions = {},
): Promise<ExtractOnlyResponse> {
  const startTotal = performance.now();
  const visionTimeoutMs = opts.visionTimeoutMs ?? DEFAULT_VISION_TIMEOUT_MS;

  const preStart = performance.now();
  const pre = await preprocessImage(imageBytes, opts.preprocessOpts);
  const preElapsed = performance.now() - preStart;

  // Wave-33 audit (Sub-agent A bug #7): separate AbortControllers for
  // OCR vs the vision call. Previously a single `ctrl` was shared, so
  // a vision-timeout fire would abort the still-running Tesseract
  // worker mid-pixel-pass — degrading the Gov-Warning bold/size
  // subscores into the model-self-report fallback path. This mirrors
  // verifyLabel's two-controller split (code-review B2).
  const ctrl = new AbortController();
  const ocrCtrl = new AbortController();
  const timeoutHandle = setTimeout(() => ctrl.abort(), visionTimeoutMs);
  // OCR gets a slightly longer budget — Tesseract on a cold worker
  // can spike to ~5 s. The Gov-Warning validator below awaits OCR up
  // to 8 s before falling back to vision-self-report flags.
  const ocrTimeoutHandle = setTimeout(
    () => ocrCtrl.abort(),
    Math.max(visionTimeoutMs, 10_000),
  );

  // Wave-33 audit (Sub-agent A bug #8): forward the external abort
  // signal into BOTH controllers. Previously `opts.abortSignal` was
  // declared in VerifyOptions but completely ignored here — a client
  // disconnect on /api/extract continued to burn the vision call to
  // completion.
  const externalAbort = opts.abortSignal;
  const onExternalAbort = (): void => {
    ctrl.abort();
    ocrCtrl.abort();
  };
  if (externalAbort) {
    if (externalAbort.aborted) onExternalAbort();
    else externalAbort.addEventListener("abort", onExternalAbort, { once: true });
  }

  const modeUsed = PRODUCTION_MODE_ID;
  const extractor = opts.extractor ?? buildDefaultExtractor();

  // extractOnly mirrors verifyLabel's no-ocr-text-to-vision policy
  // (Hermes audit, BLOCKER #4 — README said "vision-only" but this
  // path was still passing ocrText into the vision prompt). OCR's
  // text is captured for debug-trace below; only ocrWords (bboxes)
  // feed the Gov-Warning validator AFTER vision returns.
  //
  // Concurrency: vision and OCR fire in parallel here, matching the
  // verifyLabel path. The legacy 1.5 s pre-vision wait was a remnant
  // of an earlier design where ocrWords were forwarded into the
  // extractor's prompt context — none of the current adapters consume
  // `ctx.ocrWords`, so blocking on it served no purpose and cost
  // ~1500 ms of wall-clock on every extract-only request. Removed
  // per Agent D perf audit 2026-05-13. The downstream Gov-Warning
  // validator awaits ocrPromise's final result (bounded 8 s).
  let ocrWords: OcrWord[] | undefined;
  let ocrElapsed: number | null = null;
  const ocrPromise: Promise<OcrResult | null> = tesseractEngine
    .run(pre.buffer, ocrCtrl.signal)
    .then((r) => {
      ocrWords = r.words;
      ocrElapsed = r.latencyMs;
      return r;
    })
    .catch(() => null);
  const visionCtx: ExtractorContext = {
    // ocrText deliberately omitted — see comment above.
    // ocrWords is undefined here (vision fires in parallel with OCR);
    // adapters don't read it anyway. The GW validator below uses the
    // ocrWords captured into the closure once OCR settles.
    ocrWords,
    signal: ctrl.signal,
  };

  let extracted: ExtractorResult;
  let fallbackUsed: string | null = null;
  try {
    try {
      extracted = await extractor.extract(pre.buffer, visionCtx);
    } catch (primaryErr) {
      const fallbackKey = process.env.OPENAI_API_KEY;
      const fallbackModel = process.env.MODEL_FALLBACK ?? "gpt-5.4-nano";
      if (!fallbackKey) throw primaryErr;
      // Self-audit fix (wave-33 pass 2): mirror verifyLabel's
      // external-abort wiring on the fallback path. Without these
      // three lines a client disconnect mid-fallback continues to
      // burn the OpenAI call. Pre-flight guard + listener +
      // cleanup match the primary path's invariant.
      if (externalAbort?.aborted) throw primaryErr;
      const remainingMs = Math.min(
        25_000,
        Math.max(5_000, visionTimeoutMs - (performance.now() - startTotal)),
      );
      const fbCtrl = new AbortController();
      const fbTimer = setTimeout(() => fbCtrl.abort(), remainingMs);
      const onExternalAbortFb = (): void => fbCtrl.abort();
      if (externalAbort && !externalAbort.aborted) {
        externalAbort.addEventListener("abort", onExternalAbortFb, { once: true });
      }
      try {
        const mod = await loadOpenAiModule();
        const fallbackExtractor = new mod.GPT4oMiniExtractor({
          apiKey: fallbackKey,
          modelVersion: fallbackModel,
        });
        extracted = await fallbackExtractor.extract(pre.buffer, {
          // ocrText omitted — same C1-falsified rationale as the
          // primary extractOnly path above.
          ocrWords,
          signal: fbCtrl.signal,
        });
        fallbackUsed = fallbackModel;
      } catch {
        throw primaryErr;
      } finally {
        clearTimeout(fbTimer);
        if (externalAbort) {
          externalAbort.removeEventListener("abort", onExternalAbortFb);
        }
      }
    }
  } finally {
    clearTimeout(timeoutHandle);
    // OCR still in flight for the Gov-Warning validator's bounded race
    // below; don't clear ocrTimeoutHandle yet (matches verifyLabel).
    if (externalAbort) {
      externalAbort.removeEventListener("abort", onExternalAbort);
    }
  }

  // Government Warning still validated — regulator-mandated text is a
  // SELF-CONTAINED check (federal regulation, not application-derived).
  // We can deliver a useful answer for that field even without app data.
  const matchStart = performance.now();
  // Bounded await: if Tesseract's still running well past the vision
  // call, we'd rather ship a vision-only Gov-Warning verdict than hang
  // until the function timeout (Vercel Hobby caps at 60s on this app).
  // 8s is plenty for a fully warm worker to finish recognising a single
  // label; a cold worker that hasn't finished by then almost certainly
  // won't in the remaining budget. The .catch(()=>null) in ocrPromise's
  // construction makes the timeout-loser harmless to the rest of the
  // pipeline. See Vercel-deploy postmortem 2026-05-12.
  //
  // Wave-33 audit (Sub-agent A bug #18): hoist the inner setTimeout
  // to a named handle so we clear it when OCR wins the race; otherwise
  // a hot serverless worker accumulates one no-op timer per call.
  let ocrRaceTimer: ReturnType<typeof setTimeout> | null = null;
  const ocrFinal = await Promise.race([
    ocrPromise,
    new Promise<null>((resolve) => {
      ocrRaceTimer = setTimeout(() => resolve(null), 8_000);
    }),
  ]);
  if (ocrRaceTimer) clearTimeout(ocrRaceTimer);
  clearTimeout(ocrTimeoutHandle);
  const f = extracted.fields;
  // extractOnly has no declared net_contents (the user didn't supply
  // any). The Gov-Warning size subscore needs SOMETHING to compute
  // the §16.22 threshold band (≤ 237 ml uses 1 mm minimum, > 237 ml
  // uses 2 mm). Prefer the extractor's own reading of the label's
  // net_contents — if the model said "750 ml" we should size against
  // that, not a generic 12 fl_oz can. Fall back to 12 fl_oz only when
  // the model didn't read it either; in that case the size subscore
  // is already advisory-not-FAIL so a wrong threshold band is
  // bounded-cost (worst case: REVIEW instead of PASS).
  const extractedNc = f.net_contents.value;
  const gov = await validateGovernmentWarning({
    extracted: f.government_warning.value ?? {
      raw_text: null,
      prefix_text: null,
      prefix_bbox: null,
      prefix_appears_bold: null,
      prefix_appears_caps: null,
    },
    declaredNetContents: extractedNc ?? { value: 12, unit: "fl_oz" },
    imageDimsPx: { width: pre.width, height: pre.height },
    ocrContext:
      ocrFinal && ocrFinal.words.length > 0
        ? { words: ocrFinal.words, imageBuffer: pre.buffer }
        : undefined,
  });
  const matchElapsed = performance.now() - matchStart;

  // 2026-05-13 fix: same imageQuality logic as the verify path —
  // only count extractor confidence on fields the model actually
  // READ (`value !== null`). Avoids tanking image-quality on
  // legitimately-absent fields like country_of_origin on US-domestic
  // labels (extractor correctly returns null with confidence 0).
  const extractorConfidences = [
    f.brand_name,
    f.class_type,
    f.abv_percent,
    f.net_contents,
    f.producer,
    f.country_of_origin,
    f.government_warning,
  ]
    .filter((x) => x.value !== null && x.value !== undefined)
    .map((x) => x.confidence);
  const meanConf =
    extractorConfidences.length > 0
      ? extractorConfidences.reduce((s, x) => s + x, 0) / extractorConfidences.length
      : 0;
  const minConf =
    extractorConfidences.length > 0 ? Math.min(...extractorConfidences) : 0;
  const imageQuality: ImageQuality =
    extractorConfidences.length === 0
      ? "bad"
      : minConf < 0.3
        ? "bad"
        : meanConf < 0.6
          ? "low"
          : "good";
  const imageQualityReason =
    imageQuality === "good"
      ? undefined
      : extractorConfidences.length === 0
        ? "The extractor could not read any fields from the image — re-photograph in better light at a sharper angle."
        : `Mean extractor confidence ${meanConf.toFixed(2)} (min ${minConf.toFixed(2)}) across ${extractorConfidences.length} fields the model could read.`;

  const totalMs = performance.now() - startTotal;

  return {
    extracted: f,
    imageQuality,
    governmentWarning: gov,
    timings: {
      preprocess: round(preElapsed),
      ocr: ocrElapsed === null ? null : round(ocrElapsed),
      vision: round(extracted.latencyMs),
      matching: round(matchElapsed),
      total: round(totalMs),
    },
    modelId: extracted.modelId,
    modelVersion: extracted.modelVersion,
    modeUsed,
    note:
      "Application data was not provided. Extracted fields are shown for reference only — no PASS/FAIL/REVIEW verdict against declared values. The Government Warning subscore is still computed (federal regulation, not application-derived).",
    ...(imageQualityReason ? { imageQualityReason } : {}),
    ...(fallbackUsed ? { fallbackUsed } : {}),
  };
}

function makeTraceId(): string {
  // Short, URL-safe, sortable-by-creation: timestamp + random tail. Not a
  // cryptographic id — this is a debug breadcrumb, not a security boundary.
  const tail = Math.random().toString(36).slice(2, 8);
  return `${Date.now().toString(36)}-${tail}`;
}

// Exported solely for unit testing (Sub-agent B B5). The function is a
// load-bearing single-point mutation that decides the final verdict —
// pinning its semantics protects against subtle refactors.
export function aggregateVerdict(statuses: ("pass" | "fail" | "review")[]): Verdict {
  if (statuses.includes("fail")) return "fail";
  if (statuses.includes("review")) return "review";
  return "pass";
}

function round(n: number): number {
  return Math.round(n);
}

let cachedExtractor: GeminiFlashExtractor | null = null;
let cachedExtractorVersion: string | undefined;
function buildDefaultExtractor(): GeminiFlashExtractor {
  const apiKey = process.env.GOOGLE_API_KEY;
  // Operations escape hatch: MODEL_PRIMARY overrides the adapter's
  // default `gemini-3.1-flash-lite` without a code change. Used by
  // wave-27 primary bake-off + any future operator-side A/B against
  // a new Google flash variant. Production main leaves this unset
  // and defaults to flash-lite.
  const overrideVersion = process.env.MODEL_PRIMARY;
  if (cachedExtractor && cachedExtractorVersion === overrideVersion) {
    return cachedExtractor;
  }
  if (!apiKey) {
    // Surface a maximally helpful message: this is the #1 deployment
    // pitfall — the user copies the repo, deploys to Vercel, and forgets
    // to add the env var. Make the next step obvious.
    throw new Error(
      "GOOGLE_API_KEY is not set in the server environment. " +
        "Add it as an Environment Variable in your Vercel project " +
        "(Settings → Environment Variables → add GOOGLE_API_KEY for " +
        "Production + Preview + Development) and redeploy. " +
        "See docs/DEPLOYMENT-CHECKLIST.md §2.",
    );
  }
  cachedExtractor = new GeminiFlashExtractor({
    apiKey,
    modelVersion: overrideVersion,
  });
  cachedExtractorVersion = overrideVersion;
  return cachedExtractor;
}
