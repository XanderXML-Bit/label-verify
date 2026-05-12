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
  },
});
