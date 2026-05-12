// Probe every OpenRouter model slug used by the bake-off with a tiny
// text-only "ok" call. Validates auth + slug availability before we sink
// real money into a 90-image x 3-trial run. Costs effectively zero
// (single-token completions, <= 12 calls).

import { readFileSync } from "node:fs";
import OpenAI from "openai";

// Minimal .env.local loader (no dotenv dependency).
function loadEnvLocal(): void {
  try {
    const text = readFileSync(".env.local", "utf8");
    for (const line of text.split(/\r?\n/)) {
      const m = /^([A-Z_][A-Z0-9_]*)=(.*)$/.exec(line);
      if (m && m[1] && !(m[1] in process.env)) {
        process.env[m[1]] = m[2]!;
      }
    }
  } catch {
    // ignore
  }
}
loadEnvLocal();

const SLUGS = [
  "google/gemini-3.1-pro-preview",
  "google/gemini-3.1-flash-lite",
  "openai/gpt-5.5",
  "openai/gpt-5.4-nano",
  "mistralai/mistral-medium-3-5",
  "nvidia/nemotron-3-nano-omni-30b-a3b-reasoning:free",
  "qwen/qwen3.6-flash",
  "meta-llama/llama-4-maverick",
  "anthropic/claude-opus-4.7",
];

async function main(): Promise<void> {
  const apiKey = process.env.OPENROUTER_API_KEY ?? "";
  if (!apiKey) {
    console.error("OPENROUTER_API_KEY missing");
    process.exit(1);
  }
  const client = new OpenAI({
    apiKey,
    baseURL: "https://openrouter.ai/api/v1",
  });
  for (const slug of SLUGS) {
    const start = Date.now();
    try {
      const resp = await client.chat.completions.create({
        model: slug,
        messages: [{ role: "user", content: "Say 'ok'." }],
        // GPT-5.x family enforces max_output_tokens >= 16, and reasoning
        // models consume some of that budget before emitting text. 32 is
        // the safe floor that still keeps probe spend negligible.
        max_tokens: 32,
        temperature: 0,
      });
      const text = resp.choices[0]?.message?.content?.trim() ?? "";
      const elapsed = Date.now() - start;
      console.log(
        "OK   " +
          slug.padEnd(55) +
          " " +
          elapsed +
          "ms  -> " +
          text.slice(0, 40),
      );
    } catch (e) {
      const msg = (e as Error).message ?? String(e);
      const first = msg.split("\n")[0] ?? msg;
      console.log("FAIL " + slug.padEnd(55) + " " + first.slice(0, 120));
    }
  }
}
main().catch((err) => {
  console.error(err);
  process.exit(1);
});
