// Rasterise the brand mark into the favicon set, and render the 1200x630 OG card
// with Playwright using locally supplied font files (no network at render time).
// Usage: node make_raster.mjs <repoDir> <fontDir>
import { createRequire } from "node:module";
import fs from "node:fs";
import path from "node:path";

const [repo, fontDir] = process.argv.slice(2);
const require = createRequire(path.join(repo, "package.json"));
const sharp = require("sharp");
const { chromium } = require("@playwright/test");

const pub = path.join(repo, "public");
const markSvg = fs.readFileSync(path.join(pub, "brand", "mark.svg"));

fs.copyFileSync(path.join(pub, "brand", "mark.svg"), path.join(pub, "favicon.svg"));

async function png(size, out, { pad = 0, bg = null } = {}) {
  const inner = size - pad * 2;
  const icon = await sharp(markSvg, { density: 1200 }).resize(inner, inner).png().toBuffer();
  const base = sharp({
    create: { width: size, height: size, channels: 4, background: bg ?? { r: 0, g: 0, b: 0, alpha: 0 } },
  });
  await base.composite([{ input: icon, left: pad, top: pad }]).png({ compressionLevel: 9 }).toFile(out);
}

await png(32, path.join(pub, "favicon-32x32.png"));
// Apple touch icon: opaque background (iOS paints transparency black).
await png(180, path.join(pub, "apple-touch-icon.png"), { bg: "#070c1a" });
await png(192, path.join(pub, "icon-192.png"));
await png(512, path.join(pub, "icon-512.png"));
// Maskable: keep the mark inside the 80 % safe zone on an opaque tile.
await png(512, path.join(pub, "icon-512-maskable.png"), { pad: 52, bg: "#070c1a" });

// favicon.ico — single 32x32 PNG-in-ICO (supported by every current browser).
const ico32 = fs.readFileSync(path.join(pub, "favicon-32x32.png"));
const header = Buffer.alloc(6 + 16);
header.writeUInt16LE(0, 0);
header.writeUInt16LE(1, 2);
header.writeUInt16LE(1, 4);
header.writeUInt8(32, 6);
header.writeUInt8(32, 7);
header.writeUInt8(0, 8);
header.writeUInt8(0, 9);
header.writeUInt16LE(1, 10);
header.writeUInt16LE(32, 12);
header.writeUInt32LE(ico32.length, 14);
header.writeUInt32LE(22, 18);
fs.writeFileSync(path.join(pub, "favicon.ico"), Buffer.concat([header, ico32]));

// OG card.
const f = (n) => `url(data:font/ttf;base64,${fs.readFileSync(path.join(fontDir, n)).toString("base64")})`;
const mark = markSvg.toString().replace(/width="64" height="64"/, 'width="132" height="132"');
const html = `<!doctype html><html><head><style>
@font-face{font-family:Sora;src:${f("Sora.ttf")};font-weight:100 900}
@font-face{font-family:Manrope;src:${f("Manrope.ttf")};font-weight:200 800}
@font-face{font-family:Plex;src:${f("PlexMono.ttf")};font-weight:500}
*{margin:0;box-sizing:border-box}
body{width:1200px;height:630px;background:#070c1a;color:#edf1f8;font-family:Manrope;position:relative;overflow:hidden}
.glow{position:absolute;inset:0;background:radial-gradient(900px 520px at 88% -10%,rgba(107,168,255,.22),transparent 60%),radial-gradient(700px 420px at -5% 110%,rgba(123,210,194,.12),transparent 60%)}
.grid{position:absolute;inset:0;background-image:linear-gradient(rgba(107,168,255,.06) 1px,transparent 1px),linear-gradient(90deg,rgba(107,168,255,.06) 1px,transparent 1px);background-size:48px 48px}
.wrap{position:absolute;inset:0;padding:84px 88px;display:flex;flex-direction:column;justify-content:space-between}
.top{display:flex;align-items:center;gap:32px}
h1{font-family:Sora;font-weight:600;font-size:84px;letter-spacing:-2px;line-height:1}
h1 span{color:#6ba8ff}
p.lede{font-size:38px;line-height:1.3;color:#c3cde0;max-width:960px;font-weight:500}
.chips{display:flex;gap:14px;margin-top:30px}
.chip{font-family:Plex;font-size:26px;padding:8px 16px;border-radius:999px;border:1.5px solid #2f3b56;color:#dce3ef}
.chip.p{border-color:#7bd2c2;color:#7bd2c2}.chip.f{border-color:#f29b9b;color:#f29b9b}.chip.r{border-color:#e3a260;color:#e3a260}
.foot{display:flex;justify-content:space-between;align-items:flex-end;font-family:Plex;font-size:25px;color:#c3cde0}
</style></head><body><div class="glow"></div><div class="grid"></div><div class="wrap">
<div><div class="top">${mark}<h1>Label <span>Verify</span></h1></div></div>
<div><p class="lede">Checks beverage-label artwork against its application data, field by field, including the Government Warning.</p>
<div class="chips"><span class="chip p">pass</span><span class="chip f">fail</span><span class="chip r">review</span></div></div>
<div class="foot"><span>Prototype · Next.js · vision LLM + OCR</span><span>Zendren · Xander M. Lopez</span></div>
</div></body></html>`;
const browser = await chromium.launch();
const page = await browser.newPage({ viewport: { width: 1200, height: 630 } });
await page.setContent(html);
await page.evaluate(() => document.fonts.ready);
await page.screenshot({ path: path.join(pub, "og-image.png") });
await browser.close();
console.log("ok");
