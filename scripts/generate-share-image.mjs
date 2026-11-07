import { readFile, writeFile } from 'node:fs/promises';
import sharp from 'sharp';

// Outlined text in the SVG avoids dependence on installed fonts.
// Rebuild with the lockfile-pinned sharp: node scripts/generate-share-image.mjs.
const source = new URL('./share-image.svg', import.meta.url);
const target = new URL('../public/share.png', import.meta.url);
await writeFile(target, await sharp(await readFile(source)).png({ compressionLevel: 9 }).toBuffer());
