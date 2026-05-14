import type { Metadata } from "next";
import Link from "next/link";

export const dynamic = "force-static";

export const metadata: Metadata = {
  title: "Privacy — LotPilot",
  description:
    "How LotPilot and our dealer customers handle your information when you chat with us.",
};

export default function PrivacyPage() {
  return (
    <main className="min-h-dvh bg-zinc-50 text-zinc-900">
      <article className="mx-auto max-w-2xl px-6 py-16 sm:py-24">
        <header className="mb-10">
          <Link
            href="/"
            className="text-xs uppercase tracking-widest text-zinc-500 hover:text-zinc-900"
          >
            LotPilot
          </Link>
          <h1 className="mt-3 text-3xl font-semibold tracking-tight sm:text-4xl">
            Privacy
          </h1>
          <p className="mt-2 text-sm text-zinc-500">Last updated: 2026-05-13</p>
        </header>

        <Section title="What this is">
          <p>
            LotPilot is an AI sales assistant used by independent
            used-car dealers. When you chat with a dealer through a
            LotPilot-powered widget, this page explains what happens to
            the messages you send.
          </p>
        </Section>

        <Section title="What we collect">
          <ul className="ml-5 list-disc space-y-1.5">
            <li>The text you type into the chat widget.</li>
            <li>
              Anything you choose to share inside that text (e.g. your
              name, ZIP code, phone number, trade-in details).
            </li>
            <li>
              An anonymous browser cookie (<code>lp_session</code>) so
              we can keep your conversation continuous on the same
              device for up to 30 days.
            </li>
            <li>
              Basic technical metadata about the request (timestamp,
              dealer, language). We do not store your IP in the
              conversation record.
            </li>
          </ul>
        </Section>

        <Section title="How we use it">
          <ul className="ml-5 list-disc space-y-1.5">
            <li>
              To generate a reply. Your message is sent to a third-party
              large language model provider (Anthropic) under a no-train
              data agreement.
            </li>
            <li>
              To let the dealer review the conversation and follow up
              with you.
            </li>
            <li>
              To improve our own founder-curated reply prompts in
              aggregate. We do not use your messages to train any AI
              model.
            </li>
          </ul>
        </Section>

        <Section title="Who sees it">
          <ul className="ml-5 list-disc space-y-1.5">
            <li>The dealer you chose to contact.</li>
            <li>
              LotPilot staff, only when troubleshooting an issue you or
              the dealer reports.
            </li>
            <li>Anthropic, as the AI provider that generates replies.</li>
            <li>
              Supabase, our database provider, where conversations are
              stored at rest.
            </li>
          </ul>
          <p>
            We do not sell your information. We do not share it with
            advertisers.
          </p>
        </Section>

        <Section title="How long we keep it">
          <p>
            Conversations are retained while the dealer is an active
            LotPilot customer, plus a 90-day window after they leave so
            you can still reach them. You can ask the dealer to delete
            your conversation at any time.
          </p>
        </Section>

        <Section title="Your choices">
          <ul className="ml-5 list-disc space-y-1.5">
            <li>
              Don&apos;t send information you don&apos;t want stored.
              The widget is a normal chat &mdash; treat it like SMS with
              a salesperson.
            </li>
            <li>
              Clear your browser cookies to disconnect future messages
              from your prior conversation.
            </li>
            <li>
              Email{" "}
              <a
                className="underline hover:text-zinc-700"
                href="mailto:privacy@lotpilot.app"
              >
                privacy@lotpilot.app
              </a>{" "}
              to request deletion of your data.
            </li>
          </ul>
        </Section>

        <Section title="Contact">
          <p>
            Privacy questions:{" "}
            <a
              className="underline hover:text-zinc-700"
              href="mailto:privacy@lotpilot.app"
            >
              privacy@lotpilot.app
            </a>
          </p>
        </Section>

        <footer className="mt-12 border-t border-zinc-200 pt-6 text-xs text-zinc-500">
          <Link href="/" className="hover:text-zinc-900">
            Back to LotPilot
          </Link>
        </footer>
      </article>
    </main>
  );
}

function Section({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <section className="mb-8 space-y-3 text-sm leading-relaxed text-zinc-700">
      <h2 className="text-base font-semibold tracking-tight text-zinc-900">
        {title}
      </h2>
      {children}
    </section>
  );
}
