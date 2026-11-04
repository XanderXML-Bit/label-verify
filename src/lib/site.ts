// Canonical public origin for metadata (canonical link, Open Graph, Twitter).
//
// One constant so the switch to the branded domain is a one-line change.
// Until labelverify.zendren.net is attached to the Vercel project, the
// production alias stays canonical — pointing canonical/OG tags at a host
// that does not resolve yet would break every share preview.
export const SITE_URL = "https://label-verify-six.vercel.app";

export const SITE_NAME = "Label Verify";
