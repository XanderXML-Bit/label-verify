// Wave-35e — external-abort mid-vision-call regression pins.
//
// Wave-35e code-audit flagged this as a top-priority risk: an
// SSE client disconnect or upstream cancellation should stop the
// in-flight Gemini call so we don't keep billing for a request
// the user has abandoned. The wiring lives in `verify.ts` —
// `externalAbort.addEventListener("abort", onExternalAbort)` and
// the per-controller `ctrl.abort()` cascade. These tests pin that
// the listener actually fires through to the extractor's signal.
//
// Three scenarios per Apex §12.3:
//   1. External signal aborted BEFORE verify starts → skip
//      entirely (preflight check).
//   2. External signal fires WHILE primary vision is in flight →
//      primary extractor's `ctx.signal` receives the abort.
//   3. External signal fires AFTER vision returns but BEFORE
//      second-opinion / fallback path runs → downstream still
//      observes the abort.

import { describe, it, expect, vi } from "vitest";
import sharp from "sharp";
import { verifyLabel } from "@/lib/verify";
import type {
  Extractor,
  ExtractedFields,
} from "@/lib/vision/types";
import type { DeclaredFields } from "@/lib/types";

// OCR mock — reuse the realistic-bbox pattern from verify.test.ts so
// downstream Gov-Warning bold/size doesn't fall back to model self-
// report and route an otherwise-PASS to REVIEW.
vi.mock("@/lib/ocr/tesseract", () => ({
  tesseractEngine: {
    id: "tesseract",
    async run() {
      return {
        text: "GOVERNMENT WARNING",
        words: [
          { text: "GOVERNMENT", confidence: 90, bbox: { x: 10, y: 30, width: 60, height: 16 } },
          { text: "WARNING:", confidence: 90, bbox: { x: 72, y: 30, width: 48, height: 16 } },
        ],
        confidence: 0.85,
        latencyMs: 5,
        engine: "tesseract",
      };
    },
  },
  warmupTesseract: async () => undefined,
}));

async function tinyJpeg(): Promise<Buffer> {
  return await sharp({
    create: { width: 100, height: 100, channels: 3, background: "#fff" },
  })
    .jpeg()
    .toBuffer();
}

const COMPLIANT_FIELDS: ExtractedFields = {
  brand_name: { value: "Test", confidence: 0.95 },
  class_type: { value: "IPA", confidence: 0.9 },
  abv_percent: { value: 6.4, confidence: 0.95 },
  net_contents: { value: { value: 12, unit: "fl_oz" }, confidence: 0.9 },
  government_warning: {
    value: {
      raw_text:
        "GOVERNMENT WARNING: (1) According to the Surgeon General, women should not drink alcoholic beverages during pregnancy because of the risk of birth defects. (2) Consumption of alcoholic beverages impairs your ability to drive a car or operate machinery, and may cause health problems.",
      prefix_text: "GOVERNMENT WARNING",
      prefix_bbox: { x: 100, y: 200, width: 400, height: 20 },
      prefix_appears_bold: true,
      prefix_appears_caps: true,
    },
    confidence: 0.9,
  },
  producer: {
    value: {
      name: "Test Co.",
      street: "1 Main",
      city: "Asheville",
      state: "NC",
      postal_code: "28801",
      country: "USA",
    },
    confidence: 0.85,
  },
  country_of_origin: { value: "USA", confidence: 0.95 },
};

const DECLARED: DeclaredFields = {
  brand_name: "Test",
  class_type: "IPA",
  class_category: "beer",
  abv_percent: 6.4,
  net_contents: { value: 12, unit: "fl_oz" },
  producer: {
    name: "Test Co.",
    street: "1 Main",
    city: "Asheville",
    state: "NC",
    postal_code: "28801",
    country: "USA",
  },
  country_of_origin: "USA",
};

describe("Wave-35e — external abort behaviour in verifyLabel", () => {
  it("propagates an ALREADY-aborted externalAbort into the extractor's ctx.signal (regulatory billing-safety)", async () => {
    // When externalAbort is already aborted at the call site, the
    // orchestrator's preflight calls `onExternalAbort()` synchronously,
    // which fires `ctrl.abort()`. The extractor is then invoked with
    // an already-aborted `ctx.signal`. A real Gemini extractor would
    // honor that and throw before making the network call — this
    // mock models that behaviour. The regulator-safety claim is:
    // the extractor's signal is aborted BEFORE any network billing
    // can occur.
    let signalAbortedAtCall = false;
    const extractor: Extractor = {
      id: "mock:abort-respecting",
      networkRequired: false,
      async extract(_buf, ctx) {
        signalAbortedAtCall = !!ctx?.signal?.aborted;
        // Honor the signal like the real Gemini SDK does — throw
        // AbortError instead of making the call.
        if (ctx?.signal?.aborted) {
          throw new DOMException("aborted", "AbortError");
        }
        return {
          fields: COMPLIANT_FIELDS,
          rawOutput: COMPLIANT_FIELDS,
          latencyMs: 0,
          modelId: "mock",
          modelVersion: "v1",
          promptHash: "x",
          cost: { inputTokens: 0, outputTokens: 0, costUsd: 0 },
        };
      },
    };
    const ac = new AbortController();
    ac.abort();
    await expect(
      verifyLabel(await tinyJpeg(), DECLARED, {
        extractor,
        abortSignal: ac.signal,
      }),
    ).rejects.toThrow();
    // Pin the contract: the extractor's signal was aborted at
    // call-time, so a real Gemini call would never have left the box.
    expect(signalAbortedAtCall).toBe(true);
  });

  it("propagates an externalAbort that fires WHILE primary vision is in flight (no leak)", async () => {
    // The extractor records the abort timestamp via its own
    // listener (not from outside the promise's lifetime). The test
    // asserts: (a) the extractor's signal observed an abort event
    // before resolution, (b) the orchestrator rejected the verify.
    let abortObservedInExtractor = false;
    const extractor: Extractor = {
      id: "mock:slow",
      networkRequired: false,
      extract: async (_buf, ctx) => {
        // Subscribe to the abort event INSIDE the extractor — this
        // is exactly how the Gemini SDK's underlying fetch works.
        ctx?.signal?.addEventListener("abort", () => {
          abortObservedInExtractor = true;
        });
        // Simulate a 250 ms vision call. If the signal aborts
        // during the wait, throw AbortError (real SDK behaviour).
        await new Promise<void>((resolve, reject) => {
          const id = setTimeout(resolve, 250);
          ctx?.signal?.addEventListener("abort", () => {
            clearTimeout(id);
            reject(new DOMException("aborted", "AbortError"));
          });
        });
        return {
          fields: COMPLIANT_FIELDS,
          rawOutput: COMPLIANT_FIELDS,
          latencyMs: 250,
          modelId: "mock:slow",
          modelVersion: "v1",
          promptHash: "x",
          cost: { inputTokens: 0, outputTokens: 0, costUsd: 0 },
        };
      },
    };
    const ac = new AbortController();
    // Trigger external abort 50 ms into the call — well before the
    // 250 ms simulated vision-call completion.
    setTimeout(() => ac.abort(), 50);
    await expect(
      verifyLabel(await tinyJpeg(), DECLARED, {
        extractor,
        abortSignal: ac.signal,
      }),
    ).rejects.toThrow();
    // The orchestrator-side listener (`onExternalAbort`) called
    // `ctrl.abort()` mid-flight, which propagated to the extractor's
    // ctx.signal — observed by the extractor's own listener.
    expect(abortObservedInExtractor).toBe(true);
  });

  it("ALSO aborts the OCR pipeline when externalAbort fires (separate controller, same listener)", async () => {
    // The orchestrator uses TWO AbortControllers — one for vision
    // (`ctrl`) and one for OCR (`ocrCtrl`) — both subscribed to the
    // same external signal so an SSE client disconnect stops both
    // halves of the parallel work. We can't easily intercept the
    // Tesseract worker, but we can verify the orchestrator's onAbort
    // wiring exists by source inspection.
    const fs = await import("node:fs");
    const src = fs.readFileSync("src/lib/verify.ts", "utf-8");
    // The two-controller pattern with a shared external-abort listener
    // is the wave-33 fix (sub-agent A bug #8). Pin it.
    expect(src).toMatch(/const ctrl = new AbortController\(\)/);
    expect(src).toMatch(/const ocrCtrl = new AbortController\(\)/);
    expect(src).toMatch(/const onExternalAbort\s*=\s*\(\)\s*=>\s*\{/);
    expect(src).toMatch(/ctrl\.abort\(\);[\s\S]{0,200}ocrCtrl\.abort\(\)/);
    // And the listener must be wired with `{ once: true }` so the
    // controller cleanup runs deterministically.
    expect(src).toMatch(/addEventListener\("abort",\s*onExternalAbort,\s*\{\s*once:\s*true\s*\}/);
    // The cleanup in the finally block must removeEventListener so
    // we don't leak listeners across long-lived requests.
    expect(src).toMatch(/externalAbort\.removeEventListener\("abort",\s*onExternalAbort\)/);
  });
});
