/** @type {import('next').NextConfig} */
const nextConfig = {
  reactStrictMode: true,
  // `standalone` output trims the Vercel deployment to only the files the
  // server actually needs. Per-route memory / region / timeout policy lives
  // in vercel.json (the source of truth).
  output: "standalone",
  // sharp and tesseract.js carry native or large WASM payloads that Next's
  // bundler should leave out of the server bundle (DEPLOYMENT.md §6).
  serverExternalPackages: ["sharp", "tesseract.js", "@napi-rs/canvas"],
  // Next.js's build-trace does NOT auto-include tesseract.js-core's WASM
  // artefacts when tesseract.js is marked external. On Vercel this means
  // `/var/task/node_modules/tesseract.js-core/tesseract-core-simd.wasm`
  // is missing at runtime — `createWorker("eng")` aborts immediately
  // with ENOENT and the whole function hangs until the 30s Hobby-plan
  // cap fires (every OCR call returns 504). Forcing the WASM + the
  // worker JS into the trace fixes it. Discovered via the Vercel
  // function logs after the 2026-05-12 redeploy.
  outputFileTracingIncludes: {
    "/api/**/*": [
      "./node_modules/tesseract.js-core/**/*.wasm",
      "./node_modules/tesseract.js-core/**/*.js",
      "./node_modules/tesseract.js/src/worker-script/node/**/*",
    ],
  },
  // Vision API responses can be large; raise the upload-body limit on the
  // verify endpoint so per-item function calls don't reject mid-batch.
  experimental: {
    serverActions: {
      bodySizeLimit: "12mb",
    },
  },
  // Forward-compatibility for any future `next/image` usage. Today no
  // component uses next/image, so this block is effectively dormant — but
  // having it in place means a later refactor picks up WebP + the right
  // breakpoint set without touching infra.
  images: {
    formats: ["image/webp"],
    deviceSizes: [360, 640, 768, 1024, 1280, 1536],
    imageSizes: [16, 32, 48, 64, 96, 128, 256, 384],
  },
};

module.exports = nextConfig;
