// User-facing copy for the keyless public demo. Kept separate from
// demo-mode.ts so client components can import the strings without
// pulling in any server environment logic. Contains no secrets.

export const OFFLINE_DEMO_CODE = "offline-demo";

export const OFFLINE_DEMO_MESSAGE =
  "This public demo runs offline: it makes no AI model calls and uses no API keys, so your own label images, URLs, extract-only and batch can't be verified here. Try one of the three bundled samples to see a full result.";

export const OFFLINE_SAMPLE_NOTE =
  "Offline sample result. No AI model was called: the label fields come from a recorded sample extraction, and the comparison and Government Warning checks ran on this server.";

export const OFFLINE_DEMO_NOTICE =
  "This public build makes no AI model calls and uses no API keys. The three samples run the real comparison and Government Warning checks on recorded sample extractions. Your own label images and application files can't be verified here, and the page does not upload them.";

/** Footer privacy notice for the offline demo. Each sentence maps to
 *  code: localStorage keys in ThemeToggle, ModeToggle and ReviewerBadge;
 *  the upload stop in page.tsx handleFiles; no cookie or analytics code
 *  in src/. The host receives every request by the nature of hosting. */
export const PRIVACY_NOTICE =
  "This demo keeps your theme, view mode and reviewer ID in this browser only (localStorage); clear this site's data to remove them. It does not upload your files, sets no cookies and runs no analytics. The host, Vercel, receives your IP address and request data for each visit.";

/** Shown when a visitor picks or drops a file of their own in the
 *  offline demo. The page stops before any request is made. */
export const OFFLINE_UPLOAD_BLOCKED =
  "This demo runs on the three samples. Your file was not uploaded.";

/** True in the browser when the page was built as the offline demo.
 *  `data-demo` is set server-side in layout.tsx from
 *  LABEL_VERIFY_LIVE_MODELS, so it is fixed for the build. */
export function isOfflineDemoPage(): boolean {
  return (
    typeof document !== "undefined" &&
    document.documentElement.dataset.demo === "offline"
  );
}
