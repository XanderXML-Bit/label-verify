// Probe which Gemini model IDs the live API accepts. Throwaway, but kept
// in scripts/ so it picks up node_modules from this project.

import { GoogleGenerativeAI } from "@google/generative-ai";

async function main(): Promise<void> {
  const apiKey = process.env.GOOGLE_API_KEY ?? "";
  if (!apiKey) {
    console.error("GOOGLE_API_KEY missing");
    process.exit(1);
  }
  const candidates = [
    "gemini-3.1-flash-lite",
    "gemini-3.1-flash-lite-preview",
    "gemini-3-flash-lite",
    "gemini-3-flash-lite-preview",
    "gemini-3.1-flash",
    "gemini-3.1-pro",
    "gemini-3.1-pro-preview",
    "gemini-3-pro",
    "gemini-3.0-flash",
    "gemini-2.5-flash-lite",
    "gemini-2.5-flash",
    "gemini-2.5-pro",
  ];
  const genAI = new GoogleGenerativeAI(apiKey);
  for (const id of candidates) {
    try {
      const model = genAI.getGenerativeModel({ model: id });
      const result = await model.generateContent("Say 'ok' (one word).");
      const text = result.response.text().trim();
      console.log(`OK   ${id.padEnd(34)} -> ${text.slice(0, 30)}`);
    } catch (e) {
      const msg = (e as Error).message ?? String(e);
      const first = msg.split("\n")[0] ?? msg;
      console.log(`FAIL ${id.padEnd(34)} ${first.slice(0, 110)}`);
    }
  }
}
main().catch((err) => {
  console.error(err);
  process.exit(1);
});
