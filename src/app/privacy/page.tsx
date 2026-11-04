import type { Metadata } from "next";
import Link from "next/link";

export const metadata: Metadata = {
  title: "Privacy | Label Verify",
  alternates: { canonical: "/privacy" },
  openGraph: { url: "/privacy" },
};

export default function PrivacyPage() {
  return (
    <article className="max-w-3xl space-y-6 text-slate-700 dark:text-slate-300">
      <h2 className="text-2xl font-semibold text-slate-900 dark:text-slate-100">
        Privacy
      </h2>
      <p>
        Use the bundled samples to evaluate this prototype. Do not upload
        confidential documents, personal identifiers, or non-public information.
      </p>
      <section className="space-y-2">
        <h3 className="text-lg font-semibold">What you submit</h3>
        <p>
          Verification sends your label images and application fields to the
          server. Image-based application parsing also sends the uploaded image
          to a vision provider. These inputs support text extraction and field
          comparison.
        </p>
        <p>
          Depending on server configuration, vision requests use Google Gemini,
          OpenAI, or Anthropic. Those providers process submitted content under
          their own terms. Vercel hosts the application and processes requests,
          including network metadata and operational logs.
        </p>
      </section>
      <section className="space-y-2">
        <h3 className="text-lg font-semibold">Server memory and retention</h3>
        <p>
          The prototype keeps recent verification traces and human-review items
          in server memory. Traces can include declared fields, extracted text,
          and results. The trace buffer holds up to 20 records. The pending
          review queue holds up to 200 items.
        </p>
        <p>
          Batch jobs can temporarily hold images and application data in memory.
          Jobs expire after 30 minutes when the next cleanup runs. Server
          restarts also clear these in-memory stores. They are not a durable
          database, and there is no guaranteed deletion time across hosting or
          vision-provider systems.
        </p>
      </section>
      <section className="space-y-2">
        <h3 className="text-lg font-semibold">Your browser</h3>
        <p>
          Local storage saves your theme, display mode, and optional reviewer ID.
          The reviewer ID can appear in exported reports. Clear this site&apos;s
          browser data to remove these preferences. Downloaded reports remain
          on your device until you delete them.
        </p>
      </section>
      <section className="space-y-2">
        <h3 className="text-lg font-semibold">Deletion requests</h3>
        <p>
          Contact{" "}
          <a className="underline" href="mailto:xandermlopez@gmail.com">
            xandermlopez@gmail.com
          </a>{" "}
          to request deletion or ask about processing. Include the request ID
          and approximate submission time, not the original sensitive content.
          Provider retention may limit what the application operator can remove.
        </p>
      </section>
      <Link className="inline-block py-3 underline" href="/">
        Return to verification
      </Link>
    </article>
  );
}
