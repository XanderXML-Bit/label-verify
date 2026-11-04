import type { Metadata, Viewport } from "next";
import Image from "next/image";
import Link from "next/link";
import { IBM_Plex_Mono, Manrope, Sora } from "next/font/google";
import "./globals.css";
import { SITE_URL } from "@/lib/site";
import { ThemeToggle } from "./components/ThemeToggle";
import { ModeToggle } from "./components/ModeToggle";
import { ReviewerBadge } from "./components/ReviewerBadge";

// Studio typography (portfolio brand family). next/font self-hosts the
// files at build time — no runtime request to Google — and applies
// font-display: swap.
const sora = Sora({
  subsets: ["latin"],
  weight: ["600", "700"],
  display: "swap",
  variable: "--font-sora",
});
const manrope = Manrope({
  subsets: ["latin"],
  display: "swap",
  variable: "--font-manrope",
});
const plexMono = IBM_Plex_Mono({
  subsets: ["latin"],
  weight: ["400", "500"],
  display: "swap",
  variable: "--font-plex-mono",
});

export const metadata: Metadata = {
  title: "Label Verify",
  description:
    "AI-powered TTB Certificate of Label Approval verification — prototype.",
  // PWA manifest — "Add to home screen" works on iOS Safari + Chrome,
  // useful for TTB ops reviewers who might pin this on a phone/tablet.
  // Manifest at /public/manifest.webmanifest (192/512 + maskable icons).
  manifest: "/manifest.webmanifest",
  // Favicon set — sources in /public/brand (mark.svg, wordmark.svg).
  icons: {
    icon: [
      { url: "/favicon.svg", type: "image/svg+xml" },
      { url: "/favicon-32x32.png", sizes: "32x32", type: "image/png" },
      { url: "/favicon.ico", sizes: "32x32" },
    ],
    apple: [{ url: "/apple-touch-icon.png", sizes: "180x180" }],
  },
  // Open Graph + Twitter so a shared link previews cleanly in iMessage,
  // Slack, Outlook, etc. Reviewers are >50; many will share via email.
  // Absolute share/canonical URLs resolve against the production alias —
  // never a preview or team deployment URL. Single-route app, so the
  // canonical is the site root.
  metadataBase: new URL(SITE_URL),
  alternates: { canonical: "/" },
  openGraph: {
    title: "Label Verify — TTB COLA prototype",
    description:
      "Verify alcohol label images against application data — ~4–6 seconds end-to-end on a warm function.",
    type: "website",
    siteName: "Label Verify",
    url: "/",
    images: [
      {
        url: "/og-image.png",
        width: 1200,
        height: 630,
        alt: "Label Verify — checks beverage-label artwork against its application data",
      },
    ],
  },
  twitter: {
    card: "summary_large_image",
    title: "Label Verify — TTB COLA prototype",
    description:
      "Verify alcohol label images against application data — ~4–6 seconds end-to-end on a warm function.",
    images: ["/og-image.png"],
  },
};

export const viewport: Viewport = {
  width: "device-width",
  initialScale: 1,
  viewportFit: "cover",
  // Address-bar chrome matches the header background token in each
  // scheme: white in light, Studio navy (slate-900 in tailwind.config.ts)
  // in dark.
  themeColor: [
    { media: "(prefers-color-scheme: light)", color: "#ffffff" },
    { media: "(prefers-color-scheme: dark)", color: "#0f172b" },
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
      className={`${sora.variable} ${manrope.variable} ${plexMono.variable}`}
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
            <div className="flex items-center gap-3">
              <Image
                src="/brand/mark.svg"
                alt=""
                width={40}
                height={40}
                className="h-10 w-10 shrink-0"
              />
              <div className="flex flex-col">
                <h1 className="text-xl font-semibold tracking-tight text-slate-900 dark:text-slate-100">
                  Label Verify
                </h1>
                <p className="text-sm text-slate-500 dark:text-slate-400">
                  TTB COLA prototype
                </p>
              </div>
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
        <footer className="mx-auto max-w-5xl px-4 py-8 pb-[max(2rem,env(safe-area-inset-bottom))] text-xs text-slate-600 dark:text-slate-400">
          TTB COLA verification prototype. Not a production verification
          service. See{" "}
          {/* Touch target ≥ 44 px tall on mobile (inline-block + py-2) so
              tapping it on a phone meets WCAG 2.5.5 / Apple HIG guidance.
              UI audit P-4. */}
          <a
            className="inline-block py-2 underline hover:text-slate-900 dark:hover:text-slate-200"
            href="https://github.com/XanderXML-Bit/label-verify"
            rel="noopener noreferrer"
            target="_blank"
          >
            github.com/XanderXML-Bit/label-verify
          </a>
          .
          <span className="mt-1 block">
            © {new Date().getFullYear()}{" "}
            <a
              className="inline-block py-2 underline hover:text-slate-900 dark:hover:text-slate-200"
              href="https://zendren.net"
            >
              Zendren
            </a>{" "}
            · Built by{" "}
            <a
              className="inline-block py-2 underline hover:text-slate-900 dark:hover:text-slate-200"
              href="https://xandermlopez.com"
              rel="author"
            >
              Xander M. Lopez
            </a>{" "}
            ·{" "}
            <Link className="inline-block py-2 underline" href="/privacy">
              Privacy
            </Link>
          </span>
        </footer>
      </body>
    </html>
  );
}
