# Brand asset generators

These scripts regenerate the files in `public/brand/`, the favicon set and `public/og-image.png`
(Zendren Studio family: navy `#070c1a`, blue `#6ba8ff`, teal `#7bd2c2`).

1. Download the OFL fonts from https://github.com/google/fonts into one folder:
   `ofl/sora/Sora[wght].ttf` → `Sora.ttf`, `ofl/manrope/Manrope[wght].ttf` → `Manrope.ttf`,
   `ofl/ibmplexmono/IBMPlexMono-Medium.ttf` → `PlexMono.ttf`.
2. Mark and outlined wordmark: `uv run --with fonttools python scripts/brand/make_svgs.py public/brand <fontDir>/Sora.ttf`
3. Favicons and OG card (needs `npx playwright install chromium`): `node scripts/brand/make_raster.mjs . <fontDir>`
