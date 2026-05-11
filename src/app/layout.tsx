import type { Metadata } from "next";
import "./globals.css";

export const metadata: Metadata = {
  title: "Label Verify",
  description:
    "AI-powered TTB Certificate of Label Approval verification — prototype.",
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
          <div className="mx-auto flex max-w-5xl items-center justify-between px-4 py-4">
            <h1 className="text-xl font-semibold tracking-tight">
              Label Verify
            </h1>
            <p className="text-sm text-slate-500">
              TTB COLA prototype · prototype
            </p>
          </div>
        </header>
        <main id="main" className="mx-auto max-w-5xl px-4 py-8">
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
