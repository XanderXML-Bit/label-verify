/** @type {import('next').NextConfig} */
const nextConfig = {
  reactStrictMode: true,
  // sharp and tesseract.js carry native or large WASM payloads that Next's
  // bundler should leave out of the server bundle (DEPLOYMENT.md §6).
  serverExternalPackages: ["sharp", "tesseract.js"],
  // Vision API responses can be large; raise the upload-body limit on the
  // verify endpoint so per-item function calls don't reject mid-batch.
  experimental: {
    serverActions: {
      bodySizeLimit: "12mb",
    },
  },
};

module.exports = nextConfig;
