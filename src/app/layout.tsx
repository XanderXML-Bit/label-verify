import type { Metadata, Viewport } from "next";
import "./globals.css";
import { ThemeToggle } from "./components/ThemeToggle";
import { ModeToggle } from "./components/ModeToggle";
import { ReviewerBadge } from "./components/ReviewerBadge";

export const metadata: Metadata = {
  title: "Label Verify",
  description:
    "AI-powered TTB Certificate of Label Approval verification — prototype.",
  // PWA manifest — "Add to home screen" works on iOS Safari + Chrome,
  // useful for TTB ops reviewers who might pin this on a phone/tablet.
  // The icon points at /icon.svg (already present); manifest at
  // /public/manifest.webmanifest.
  manifest: "/manifest.webmanifest",
  // Open Graph + Twitter so a shared link previews cleanly in iMessage,
  // Slack, Outlook, etc. Reviewers are >50; many will share via email.
  openGraph: {
    title: "Label Verify — TTB COLA prototype",
    description:
      "Verify alcohol label images against application data — ~4–6 seconds end-to-end on a warm function.",
    type: "website",
    siteName: "Label Verify",
  },
  twitter: {
    card: "summary",
    title: "Label Verify — TTB COLA prototype",
    description:
      "Verify alcohol label images against application data — ~4–6 seconds end-to-end on a warm function.",
  },
};

export const viewport: Viewport = {
  width: "device-width",
  initialScale: 1,
  viewportFit: "cover",
  // Both light- and dark-scheme browsers get the same dark slate for the
  // address-bar chrome. The contrast is acceptable in either OS theme.
  themeColor: [
    { media: "(prefers-color-scheme: light)", color: "#0f172a" },
    { media: "(prefers-color-scheme: dark)", color: "#0f172a" },
  ],
};

// Pre-paint inline script: read the stored theme (or prefers-color-scheme)
// and set <html data-theme="…"> *before* React hydrates. Without this the
// page would render light, repaint dark, and reviewers on a dark OS would
// see a white flash on every navigation. Kept tiny so it's not a
// perceptible parse cost.
const THEME_INIT_SCRIPT = `
(function () {
  try {
    var k = 'labelverify:theme';
    var s = window.localStorage.getItem(k);
    var t = s === 'dark' || s === 'light'
      ? s
      : (window.matchMedia('(prefers-color-scheme: dark)').matches ? 'dark' : 'light');
    document.documentElement.setAttribute('data-theme', t);
  } catch (_) {
    document.documentElement.setAttribute('data-theme', 'light');
  }
})();
`.trim();

// Pre-paint view-mode bootstrap. Sets <html data-mode="simple|detailed">
// before React hydrates so simple-mode visitors don't briefly see the
// full detailed UI render and then collapse. Default is "simple" — a
// first-time non-technical reviewer should land on the simpler surface
// (and we expect repeat operators to flip it to "detailed" and have the
// choice persist).
const MODE_INIT_SCRIPT = `
(function () {
  try {
    var k = 'labelverify:mode';
    var s = window.localStorage.getItem(k);
    var m = s === 'simple' || s === 'detailed' ? s : 'simple';
    document.documentElement.setAttribute('data-mode', m);
  } catch (_) {
    document.documentElement.setAttribute('data-mode', 'simple');
  }
})();
`.trim();

export default function RootLayout({
  children,
}: {
  readonly children: React.ReactNode;
}) {
  return (
    <html
      lang="en"
      data-theme="light"
      data-mode="simple"
      suppressHydrationWarning
    >
      <head>
        {/* Pre-paint theme + mode bootstraps — see *_INIT_SCRIPT above.
            Script bodies are string literals under our control; no
            user-provided content, so dangerouslySetInnerHTML is safe. */}
        <script
          // eslint-disable-next-line react/no-danger
          dangerouslySetInnerHTML={{ __html: THEME_INIT_SCRIPT }}
        />
        <script
          // eslint-disable-next-line react/no-danger
          dangerouslySetInnerHTML={{ __html: MODE_INIT_SCRIPT }}
        />
      </head>
      <body className="min-h-screen bg-slate-50 text-slate-900 antialiased dark:bg-slate-950 dark:text-slate-100">
        <a
          href="#main"
          className="sr-only focus:not-sr-only focus:absolute focus:left-2 focus:top-2 focus:rounded focus:bg-white focus:px-3 focus:py-2 focus:text-sm focus:shadow dark:focus:bg-slate-800 dark:focus:text-slate-100"
        >
          Skip to main content
        </a>
        <header className="border-b border-slate-200 bg-white dark:border-slate-700 dark:bg-slate-900">
          <div className="mx-auto flex max-w-5xl flex-wrap items-center justify-between gap-2 px-4 py-4 sm:flex-nowrap">
            <div className="flex flex-col">
              <h1 className="text-xl font-semibold tracking-tight text-slate-900 dark:text-slate-100">
                Label Verify
              </h1>
              <p className="text-sm text-slate-500 dark:text-slate-400">
                TTB COLA prototype
              </p>
            </div>
            <div className="flex flex-wrap items-center gap-2">
              <ReviewerBadge />
              <ModeToggle />
              <ThemeToggle />
            </div>
          </div>
        </header>
        <main id="main" className="mx-auto max-w-5xl px-4 py-6 sm:py-8">
          {children}
        </main>
        {/* `pb-[env(safe-area-inset-bottom)]` adds breathing room below
            the GitHub link on iPhones with a home indicator — without
            it the underline sits under the indicator on iOS Safari
            when `viewportFit: "cover"` is set on the viewport meta.
            UX audit P-9. The inset is 0 on devices that don't have one,
            so it's a no-op everywhere else. */}
        <footer className="mx-auto max-w-5xl px-4 py-8 pb-[max(2rem,env(safe-area-inset-bottom))] text-xs text-slate-400 dark:text-slate-500">
          TTB COLA verification prototype. Not a production verification
          service. See{" "}
          {/* Touch target ≥ 44 px tall on mobile (inline-block + py-2) so
              tapping it on a phone meets WCAG 2.5.5 / Apple HIG guidance.
              UI audit P-4. */}
          <a
            className="inline-block py-2 underline hover:text-slate-600 dark:hover:text-slate-300"
            href="https://github.com/XanderXML-Bit/label-verify"
            rel="noopener noreferrer"
            target="_blank"
          >
            github.com/XanderXML-Bit/label-verify
          </a>
          .
        </footer>
      </body>
    </html>
  );
}
