import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { spawn } from 'node:child_process';
import { createServer } from 'node:net';
import path from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { JSDOM } from 'jsdom';
import sharp from 'sharp';

const origin = new URL(process.argv[2] || 'https://label-verify-six.vercel.app').origin;
const html = await readFile('.next/server/app/index.html', 'utf8');
const document = new JSDOM(html).window.document;
const expected = [
  ['link[rel="canonical"]', 'href', `${origin}/`],
  ['meta[property="og:url"]', 'content', `${origin}/`],
  ['meta[property="og:image"]', 'content', `${origin}/share.png`],
  ['meta[property="og:image:width"]', 'content', '1200'],
  ['meta[property="og:image:height"]', 'content', '630'],
  ['meta[property="og:image:alt"]', 'content', 'Label Verify'],
  ['meta[name="twitter:image"]', 'content', `${origin}/share.png`],
  ['meta[name="twitter:card"]', 'content', 'summary_large_image'],
];
function verifyHead(head) {
  for (const [selector, attribute, value] of expected) {
    const nodes = head.querySelectorAll(selector);
    assert.equal(nodes.length, 1, selector);
    const actual = nodes[0].getAttribute(attribute);
    assert.equal(value.startsWith('https://') ? new URL(actual).href : actual, value, selector);
  }
}
verifyHead(document.head);

// Exercise the production server, not a development renderer or source-only assertion.
const reservation = createServer();
await new Promise((resolve) => reservation.listen(0, '127.0.0.1', resolve));
const port = reservation.address().port;
await new Promise((resolve) => reservation.close(resolve));
const server = spawn(process.execPath, ['node_modules/next/dist/bin/next', 'start', '--hostname', '127.0.0.1', '--port', String(port)], {
  stdio: ['ignore', 'pipe', 'pipe'],
});
let serverLog = '';
server.stdout.on('data', (data) => { serverLog += data; });
server.stderr.on('data', (data) => { serverLog += data; });
const base = `http://127.0.0.1:${port}`;
try {
  let response;
  for (let attempt = 0; attempt < 100; attempt++) {
    if (server.exitCode !== null) throw new Error(serverLog);
    try { response = await fetch(base); } catch { /* Startup is bounded below. */ }
    if (response) break;
    await delay(100);
  }
  assert.ok(response, `Production server did not start: ${serverLog}`);
  assert.equal(response.status, 200);
  const served = new JSDOM(await response.text()).window.document;
  verifyHead(served.head);
  for (const node of served.head.querySelectorAll('meta[property="og:image"], meta[name="twitter:image"]')) {
    const url = new URL(node.content);
    assert.equal(url.origin, origin);
    const file = await readFile(path.join('public', url.pathname));
    assert.equal(file.subarray(0, 8).toString('hex'), '89504e470d0a1a0a');
    assert.ok(file.length < 300_000, 'Share PNG must stay below 300 KB');
    const image = await sharp(file).metadata();
    assert.equal(image.width, 1200);
    assert.equal(image.height, 630);
    const result = await fetch(new URL(url.pathname, base));
    assert.equal(result.status, 200);
    assert.equal(result.headers.get('content-type')?.split(';')[0], 'image/png');
    assert.deepEqual(Buffer.from(await result.arrayBuffer()), file);
  }
  console.log(`Built and served metadata, image bytes, dimensions, and content type pass: ${origin}`);
} finally {
  server.kill('SIGTERM');
  if (server.exitCode === null) await new Promise((resolve) => server.once('exit', resolve));
}
