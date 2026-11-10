// Run after npm run build. No provider request or key is needed.
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { readFile } from "node:fs/promises";
import net from "node:net";
import path from "node:path";
import { once } from "node:events";
import { pdfSmokeEnv } from "./pdf-smoke-env.mjs";

const root = path.resolve(process.argv[2] ?? ".next/standalone");
const fixtures = path.resolve("src/tests/fixtures/pdf");
const declared = {
  brand_name: "Fixture",
  class_type: "Wine",
  class_category: "wine",
  abv_percent: 12,
  net_contents: { value: 750, unit: "ml" },
};

for (const mode of ["0", "1"]) {
  const reservation = net.createServer();
  reservation.listen(0, "127.0.0.1");
  await once(reservation, "listening");
  const { port } = reservation.address();
  await new Promise((resolve) => reservation.close(resolve));
  const env = pdfSmokeEnv(process.env, port, mode);
  const child = spawn(process.execPath, [path.join(root, "server.js")], {
    cwd: root,
    env,
    stdio: ["ignore", "pipe", "pipe"],
  });
  let logs = "";
  child.stdout.on("data", (chunk) => { logs += chunk; });
  child.stderr.on("data", (chunk) => { logs += chunk; });
  let spawnError;
  child.on("error", (error) => { spawnError = error; });
  try {
    const base = `http://127.0.0.1:${port}`;
    const deadline = Date.now() + 30_000;
    while (true) {
      assert.equal(spawnError, undefined);
      assert.equal(child.exitCode, null, logs);
      try {
        const response = await fetch(`${base}/api/health`, { signal: AbortSignal.timeout(1000) });
        await response.arrayBuffer();
        break;
      } catch {
        assert.ok(Date.now() < deadline, `Server did not start: ${logs}`);
        await new Promise((resolve) => setTimeout(resolve, 100));
      }
    }
    for (const name of ["standard-fonts.pdf", "embedded-font.pdf", "scanned-image.pdf"]) {
      for (const route of ["extract", "verify"]) {
        const form = new FormData();
        form.set("image", new Blob([await readFile(path.join(fixtures, name))], { type: "application/pdf" }), name);
        form.set("declared", JSON.stringify(declared));
        const response = await fetch(`${base}/api/${route}`, {
          method: "POST",
          body: form,
          signal: AbortSignal.timeout(30_000),
        });
        const body = await response.json();
        if (mode === "0") {
          assert.equal(response.status, 503, JSON.stringify(body));
          assert.equal(body.code, "offline-demo");
        } else {
          // The missing-key guard runs only after PDF rendering finishes.
          assert.equal(response.status, route === "extract" ? 502 : 500, JSON.stringify(body));
          assert.match(body.error, /GOOGLE_API_KEY is not set/);
          assert.doesNotMatch(body.error, /Could not (parse|render)|PDF processing failed/);
        }
        console.log(JSON.stringify({ mode, name, route, status: response.status, error: body.error }));
      }
    }
    assert.doesNotMatch(logs, /standardFontDataUrl|Cannot polyfill|ignoring character|fake worker failed/);
  } finally {
    if (child.exitCode === null) {
      const exited = once(child, "exit");
      child.kill("SIGTERM");
      const forceKill = setTimeout(() => child.kill("SIGKILL"), 3000);
      await exited;
      clearTimeout(forceKill);
    }
  }
}
console.log("PASS: packaged PDF routes render all fixtures; offline uploads stay blocked.");
