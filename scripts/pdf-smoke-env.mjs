// Empty values prevent Next.js from restoring provider keys from dotenv files.
export function pdfSmokeEnv(parentEnv, port, mode) {
  const env = {
    ...parentEnv,
    HOSTNAME: "127.0.0.1",
    PORT: String(port),
    LABEL_VERIFY_LIVE_MODELS: mode,
  };
  for (const key of ["GOOGLE_API_KEY", "OPENAI_API_KEY", "ANTHROPIC_API_KEY", "OPENROUTER_API_KEY"]) {
    env[key] = "";
  }
  return env;
}
