import OpenAI from "openai";

async function main(): Promise<void> {
  const apiKey = process.env.OPENAI_API_KEY ?? "";
  if (!apiKey) {
    console.error("OPENAI_API_KEY missing");
    process.exit(1);
  }
  const candidates = [
    "gpt-5-nano",
    "gpt-5",
    "gpt-5-mini",
    "gpt-5.4-nano",
    "gpt-5.4",
    "gpt-5.1-nano",
    "gpt-5.1",
    "gpt-4.1-nano",
    "gpt-4.1",
    "gpt-4o-mini",
    "gpt-4o",
  ];
  const client = new OpenAI({ apiKey });
  for (const id of candidates) {
    try {
      const resp = await client.chat.completions.create({
        model: id,
        messages: [{ role: "user", content: "Say 'ok'." }],
        max_tokens: 5,
      });
      const text = resp.choices[0]?.message?.content?.trim() ?? "";
      console.log(`OK   ${id.padEnd(20)} -> ${text.slice(0, 30)}`);
    } catch (e) {
      const msg = (e as Error).message ?? String(e);
      const first = msg.split("\n")[0] ?? msg;
      console.log(`FAIL ${id.padEnd(20)} ${first.slice(0, 110)}`);
    }
  }
}
main().catch((err) => {
  console.error(err);
  process.exit(1);
});
