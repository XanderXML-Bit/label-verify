import { chromium } from '@playwright/test';
import { createRequire } from 'node:module';
import { mkdir, writeFile } from 'node:fs/promises';
import assert from 'node:assert/strict';
import { createCanvas, loadImage } from '@napi-rs/canvas';

// Run against a built local server. Never send verification or warmup requests.
const require = createRequire(import.meta.url);
const phase = process.env.QA_PHASE ?? 'after';
const out = process.env.QA_OUTPUT ?? '../evidence';
await mkdir(out, { recursive: true });
const browser = await chromium.launch({ headless: true });
const records = [];
const focusRecords = [];
async function pixels(buffer) {
  const image = await loadImage(buffer);
  const canvas = createCanvas(image.width, image.height);
  const context = canvas.getContext('2d');
  context.drawImage(image, 0, 0);
  return { width: image.width, data: context.getImageData(0, 0, image.width, image.height).data };
}
function luminance(rgb) {
  return rgb.map(v => v / 255).map(v => v <= 0.04045 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4)
    .reduce((sum, v, i) => sum + v * [0.2126, 0.7152, 0.0722][i], 0);
}
async function verifyPaintedFocus(page, element, name, width, theme, mode) {
  const box = await element.boundingBox();
  const viewport = page.viewportSize();
  const clip = { x: Math.max(0, Math.floor(box.x) - 4), y: Math.max(0, Math.floor(box.y) - 4) };
  clip.width = Math.min(viewport.width - clip.x, Math.ceil(box.x + box.width + 4) - clip.x);
  clip.height = Math.min(viewport.height - clip.y, Math.ceil(box.y + box.height + 4) - clip.y);
  const focusedBuffer = await page.screenshot({ clip });
  await element.evaluate(e => e.blur());
  const blurredBuffer = await page.screenshot({ clip });
  await element.focus();
  const focused = await pixels(focusedBuffer);
  const blurred = await pixels(blurredBuffer);
  const changed = [];
  for (let i = 0; i < focused.data.length; i += 4) {
    const a = [...focused.data.slice(i, i + 3)];
    const b = [...blurred.data.slice(i, i + 3)];
    const low = Math.min(luminance(a), luminance(b));
    const high = Math.max(luminance(a), luminance(b));
    if ((high + 0.05) / (low + 0.05) >= 3) changed.push([i / 4 % focused.width, Math.floor(i / 4 / focused.width)]);
  }
  const spanX = changed.length ? Math.max(...changed.map(p => p[0])) - Math.min(...changed.map(p => p[0])) : 0;
  const spanY = changed.length ? Math.max(...changed.map(p => p[1])) - Math.min(...changed.map(p => p[1])) : 0;
  const result = { width, theme, mode, name, contrastPixels: changed.length, spanX, spanY };
  focusRecords.push(result);
  await writeFile(`${out}/focus.json`, JSON.stringify(focusRecords, null, 2));
  await writeFile(`${out}/focus-${width}-${theme}-${mode}-${name}.png`, focusedBuffer);
  await writeFile(`${out}/blur-${width}-${theme}-${mode}-${name}.png`, blurredBuffer);
  assert.ok(changed.length >= 44 && spanX >= box.width / 2 && spanY >= box.height / 2,
    `Painted keyboard focus must change at least 44 pixels at 3:1 across both axes: ${JSON.stringify(result)}`);
}
try {
  for (const width of [320, 768, 1280]) {
    for (const theme of ['light', 'dark']) {
      const context = await browser.newContext({ viewport: { width, height: 900 }, colorScheme: theme });
      await context.addInitScript((theme) => localStorage.setItem('labelverify:theme', theme), theme);
      await context.route('**/api/**', route => route.abort());
      const page = await context.newPage();
      await page.goto(process.env.QA_URL ?? 'http://127.0.0.1:3124', { waitUntil: 'domcontentloaded' });
      await page.getByText('Choose folder', { exact: true }).waitFor();
      await page.evaluate(theme => document.documentElement.setAttribute('data-theme', theme), theme);
      for (const mode of ['Simple', 'Detailed']) {
        await page.getByRole('button', { name: mode, exact: true }).click();
        await page.waitForTimeout(300);
        await page.addScriptTag({ path: require.resolve('axe-core/axe.min.js') });
        const axe = await page.evaluate(async () => window.axe.run(document, {
          rules: { 'label-content-name-mismatch': { enabled: true } },
        }));
        const scoped = await page.evaluate(async () => window.axe.run({ include: [
          'body > header', 'footer', '[aria-label="Label upload area"]',
        ] }, { rules: { 'label-content-name-mismatch': { enabled: true } } }));
        const data = await page.evaluate(() => {
          const targets = [...document.querySelectorAll('body > header button, footer a')].filter(e => e.checkVisibility()).map(e => {
            const r = e.getBoundingClientRect();
            return { text: e.innerText, name: e.getAttribute('aria-label'), width: r.width, height: r.height };
          });
          return { targets, text: document.body.innerText, overflow: document.documentElement.scrollWidth > innerWidth };
        });
        const record = { phase, width, theme, mode, ...data, axeVersion: axe.testEngine.version,
          scopedViolations: scoped.violations,
          violations: axe.violations.map(v => ({ id: v.id, impact: v.impact, nodes: v.nodes.map(n => ({ target: n.target, summary: n.failureSummary, data: n.any })) })) };
        await page.screenshot({ path: `${out}/${phase}-${width}-${theme}-${mode.toLowerCase()}.png`, fullPage: true });
        records.push(record);
      if (phase !== 'before') {
        const targets = page.locator('body > header button, footer a');
        for (const target of await targets.all()) {
          await target.scrollIntoViewIfNeeded();
          assert.ok(await target.evaluate(e => {
            const r = e.getBoundingClientRect();
            return [[r.x + r.width / 2, r.y + r.height / 2], [r.x + 1, r.y + r.height / 2],
              [r.right - 1, r.y + r.height / 2], [r.x + r.width / 2, r.y + 1],
              [r.x + r.width / 2, r.bottom - 1]].every(([x, y]) => e.contains(document.elementFromPoint(x, y)));
          }), `Target must receive center and edge hits: ${width}/${theme}/${await target.innerText()}`);
        }
        // Reach every scoped control by Tab, rather than assigning focus.
        const expected = await targets.count();
        const reached = new Set();
        for (let i = 0; i < 40 && reached.size < expected; i++) {
          await page.keyboard.press('Tab');
          const active = await page.evaluate(() => {
            const e = document.activeElement;
            const all = [...document.querySelectorAll('body > header button, footer a')];
            const index = all.indexOf(e);
            return { index };
          });
          if (active.index >= 0) {
            const element = await page.locator(':focus').elementHandle();
            await verifyPaintedFocus(page, element, `control-${active.index}`, width, theme, mode);
            reached.add(active.index);
          }
        }
        assert.equal(reached.size, expected, 'Every scoped control must be Tab-reachable');
        await page.getByRole('button', { name: 'Reviewer: + set ID for the audit trail', exact: true }).click();
        for (const control of await page.locator('body > header form input, body > header form button').all()) {
          const box = await control.boundingBox();
          assert.ok(box.width >= 44 && box.height >= 44, 'Reviewer editing targets must reach 44 px');
        }
        assert.equal(await page.evaluate(() => document.documentElement.scrollWidth > innerWidth), false);
        await page.getByRole('button', { name: 'Cancel editing reviewer ID' }).click();
      }
      }
      await context.close();
    }
  }
} finally { await browser.close(); }
await writeFile(`${out}/${phase}.json`, JSON.stringify(records, null, 2));
if (phase !== 'before') {
  for (const row of records) {
    assert.equal(row.overflow, false, `${row.width} overflow`);
    for (const target of row.targets) {
      assert.ok(target.width >= 44 && target.height >= 44, JSON.stringify(target));
    }
    assert.equal(row.scopedViolations.filter(v => ['color-contrast', 'label-content-name-mismatch'].includes(v.id)).length, 0, JSON.stringify(row.scopedViolations));
    assert.equal(row.scopedViolations.filter(v => ['serious', 'critical'].includes(v.impact)).length, 0, JSON.stringify(row.scopedViolations));
  }
}
console.log(`${phase}: ${records.length} viewport/theme/mode checks recorded`);
