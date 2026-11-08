import { chromium } from 'playwright';
import { createRequire } from 'node:module';
import { mkdir, writeFile } from 'node:fs/promises';
import assert from 'node:assert/strict';

// Run against a built local server. Never send verification or warmup requests.
const require = createRequire(import.meta.url);
const phase = process.env.QA_PHASE ?? 'after';
const out = process.env.QA_OUTPUT ?? '../evidence';
await mkdir(out, { recursive: true });
const browser = await chromium.launch({ headless: true });
const records = [];
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
      }
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
            const style = getComputedStyle(e);
            return { index, visible: style.outlineStyle !== 'none' && parseFloat(style.outlineWidth) > 0 };
          });
          if (active.index >= 0) {
            assert.ok(active.visible, 'Keyboard focus must remain visible');
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
