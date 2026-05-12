import type { Metadata, Viewport } from "next";
import "./globals.css";

export const metadata: Metadata = {
  title: "Label Verify",
  description:
    "AI-powered TTB Certificate of Label Approval verification — prototype.",
  // Open Graph + Twitter so a shared link previews cleanly in iMessage,
  // Slack, Outlook, etc. Reviewers are >50; many will share via email.
  openGraph: {
    title: "Label Verify — TTB COLA prototype",
    description:
      "Verify alcohol label images against application data in under 5 seconds.",
    type: "website",
    siteName: "Label Verify",
  },
  twitter: {
    card: "summary",
    title: "Label Verify — TTB COLA prototype",
    description:
      "Verify alcohol label images against application data in under 5 seconds.",
  },
};

export const viewport: Viewport = {
  width: "device-width",
  initialScale: 1,
  viewportFit: "cover",
  themeColor: "#0f172a",
  colorScheme: "light",
};

export default function RootLayout({
  children,
}: {
  readonly children: React.ReactNode;
}) {
  return (
    <html lang="en">
      <body className="min-h-screen bg-slate-50 text-slate-900 antialiased">
        <a
          href="#main"
          className="sr-only focus:not-sr-only focus:absolute focus:left-2 focus:top-2 focus:rounded focus:bg-white focus:px-3 focus:py-2 focus:text-sm focus:shadow"
        >
          Skip to main content
        </a>
        <header className="border-b border-slate-200 bg-white">
          <div className="mx-auto flex max-w-5xl flex-wrap items-center justify-between gap-2 px-4 py-4 sm:flex-nowrap">
            <h1 className="text-xl font-semibold tracking-tight">
              Label Verify
            </h1>
            <p className="text-sm text-slate-500">
              TTB COLA prototype · prototype
            </p>
          </div>
        </header>
        <main id="main" className="mx-auto max-w-5xl px-4 py-6 sm:py-8">
          {children}
        </main>
        <footer className="mx-auto max-w-5xl px-4 py-8 text-xs text-slate-400">
          Prototype for the U.S. Department of the Treasury, Alcohol and
          Tobacco Tax and Trade Bureau. Not a production verification
          service. See{" "}
          <a
            className="underline hover:text-slate-600"
            href="https://github.com/XanderXML-Bit/label-verify"
          >
            github.com/XanderXML-Bit/label-verify
          </a>
          .
        </footer>
      </body>
    </html>
  );
}
