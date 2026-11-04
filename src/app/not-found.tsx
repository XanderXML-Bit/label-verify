import Link from "next/link";

// Branded 404. Renders inside the root layout (header + footer), and Next
// returns HTTP 404 for it.
export default function NotFound() {
  return (
    <section className="mx-auto max-w-xl py-16 text-center">
      <p className="font-mono text-sm text-slate-600 dark:text-slate-400">404</p>
      <h2 className="mt-2 text-2xl font-semibold tracking-tight text-slate-900 dark:text-slate-100">
        This page does not exist
      </h2>
      <p className="mt-3 text-base text-slate-600 dark:text-slate-300">
        Return to the verifier to check a label.
      </p>
      <Link
        href="/"
        className="mt-6 inline-flex min-h-[44px] items-center rounded-md bg-blue-600 px-5 py-2.5 text-sm font-semibold text-white hover:bg-blue-700 dark:bg-blue-600 dark:hover:bg-blue-700"
      >
        Go to the verifier
      </Link>
    </section>
  );
}
