import { readFile, writeFile } from 'node:fs/promises';
import sharp from 'sharp';

// Rebuild with the lockfile-pinned sharp: node scripts/generate-maskable-icon.mjs.
const source = new URL('./icon-maskable.svg', import.meta.url);
const target = new URL('../public/icon-maskable-512.png', import.meta.url);
const png = await sharp(await readFile(source), { density: 1536 })
  .resize(512, 512)
  .png({ compressionLevel: 9 })
  .toBuffer();
await writeFile(target, png);
