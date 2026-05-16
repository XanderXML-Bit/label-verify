import { defineConfig } from "vitest/config";
import { fileURLToPath } from "node:url";

export default defineConfig({
  // tsconfig has `"jsx": "preserve"` for Next.js. Vitest's transform pipeline
  // needs an explicit automatic JSX runtime so .tsx files compile without a
  // manual `import React from "react"` in every test file.
  esbuild: {
    jsx: "automatic",
  },
  resolve: {
    alias: {
      "@": fileURLToPath(new URL("./src", import.meta.url)),
    },
  },
  test: {
    include: [
      "src/tests/**/*.test.ts",
      "src/tests/**/*.test.tsx",
      "benchmarks/**/*.test.ts",
    ],
    // Node by default — the pre-existing tests are node-environment and
    // should stay that way. The UI tests under src/tests/ui/** opt into
    // jsdom via environmentMatchGlobs so we don't pay the jsdom startup
    // cost for every non-DOM test, and so that node-shaped tests (which
    // import node:url, sharp, pdfjs, etc.) aren't polluted by the jsdom
    // global window.
    environment: "node",
    environmentMatchGlobs: [["src/tests/ui/**", "jsdom"]],
    setupFiles: ["src/tests/setup.ts"],
    // v8 coverage with realistic include/exclude. CLIs in bin/ are
    // tested via subprocess spawn (`execFileSync npx tsx bin/...`), so
    // their statements don't register through the in-process v8 hooks
    // even though they are functionally covered — explicitly exclude
    // to keep the % honest. Research and corpus-generation scripts
    // under scripts/ and benchmarks/ are not production code.
    coverage: {
      provider: "v8",
      reporter: ["text-summary", "json-summary", "html"],
      include: [
        "src/lib/**/*.{ts,tsx}",
        "src/app/api/**/*.{ts,tsx}",
        "src/lib/validation/**/*.{ts,tsx}",
        "src/lib/matching/**/*.{ts,tsx}",
        "src/lib/vision/**/*.{ts,tsx}",
        "src/lib/ocr/**/*.{ts,tsx}",
        "src/lib/application/**/*.{ts,tsx}",
      ],
      exclude: [
        "bin/**",
        "scripts/**",
        "benchmarks/**",
        "src/app/page.tsx",
        "src/app/layout.tsx",
        "src/app/components/**",
        "src/tests/**",
        "src/lib/vision/hf/**",
        "src/lib/ocr/paddleocr.ts",
        // Pure re-export barrels — no executable logic; v8 attributes the
        // module-init lines to them and never marks them "covered".
        "src/lib/vision/index.ts",
        "src/lib/ocr/index.ts",
        // Browser-only module: runs in the client, instrumented in DOM
        // tests under src/tests/ui/** (which use jsdom). Coverage hooks
        // miss it because it imports `window`-only APIs that the
        // node-env tests can't load. Documented in TEST-STRATEGY.md.
        "src/lib/client-compress.ts",
        "**/*.test.{ts,tsx}",
        "**/*.d.ts",
        "src/lib/types.ts",
      ],
    },
  },
});
