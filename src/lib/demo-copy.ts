// User-facing copy for the keyless public demo. Kept separate from
// demo-mode.ts so client components can import the strings without
// pulling in any server environment logic. Contains no secrets.

export const OFFLINE_DEMO_CODE = "offline-demo";

export const OFFLINE_DEMO_MESSAGE =
  "This public demo runs offline: it makes no AI model calls and uses no API keys, so uploads, URLs, extract-only and batch are turned off. Try one of the three bundled samples to see a full result.";

export const OFFLINE_SAMPLE_NOTE =
  "Offline sample result. No AI model was called: the label fields come from a recorded sample extraction, and the comparison and Government Warning checks ran on this server.";

export const OFFLINE_DEMO_NOTICE =
  "This public build makes no AI model calls and uses no API keys. The three samples run the real comparison and Government Warning checks on recorded sample extractions; uploads are turned off.";
