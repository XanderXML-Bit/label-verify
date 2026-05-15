// Test bootstrap. Loaded by Vitest before any test file runs.
//
// Importing the /vitest entry point augments Vitest's `expect` with the
// `@testing-library/jest-dom` matchers (toBeInTheDocument, toHaveAttribute,
// etc.) without needing a global `expect.extend` call.
import "@testing-library/jest-dom/vitest";

// Wave-31j: production default flips `withoutEnlargement: false` so the
// preprocess step Lanczos-upscales sub-target images to a 2000-px long
// edge. Existing integration tests use 100×100 synthetic JPEGs with
// hand-tuned bbox/OCR-word coordinates — upscaling those changes the
// downstream bold/size measurements and breaks the tests. Set the
// `LV_ENLARGE=0` env override so tests preserve their pre-wave-31j
// behaviour. Production code (verifyLabel as called from real API
// handlers) is unaffected — env is only set inside the vitest process.
process.env.LV_ENLARGE = "0";
import { afterEach } from "vitest";
import { cleanup } from "@testing-library/react";

// React Testing Library's auto-cleanup only fires when a global `afterEach`
// is detected at import time (Jest behavior). Vitest exposes one but it
// isn't a global by default, so wire it up here.
afterEach(() => {
  cleanup();
});

// jsdom does not implement URL.createObjectURL / revokeObjectURL — some
// components touch them (e.g. BatchView's CSV download). Polyfill no-ops
// on the global window so UI tests don't blow up at import time. Guarded
// so node-environment tests, which have no window, are unaffected.
if (typeof window !== "undefined") {
  if (typeof window.URL.createObjectURL !== "function") {
    Object.assign(window.URL, {
      createObjectURL: () => "blob:mock",
      revokeObjectURL: () => {},
    });
  }
}
