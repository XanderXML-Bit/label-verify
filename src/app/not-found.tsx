import Link from "next/link";

// The default Next.js 404 left a visitor inside the app shell with no
// way back (design audit 2026-11-13). Same shell, plus a link home.
export default function NotFound() {
  return (
    <div className="space-y-4">
      <h2 className="text-2xl font-semibold tracking-tight text-slate-900 dark:text-slate-100">
        Page not found
      </h2>
      <p className="text-slate-600 dark:text-slate-300">
        There is nothing at this address.
      </p>
      <Link
        href="/"
        className="inline-flex min-h-[44px] items-center rounded-md bg-slate-900 px-5 py-2.5 text-sm font-semibold text-white hover:bg-slate-700 dark:bg-blue-600 dark:hover:bg-blue-500"
      >
        Go to Label Verify
      </Link>
    </div>
  );
}
