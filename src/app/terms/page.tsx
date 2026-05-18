// Terms of Service (v0.8.2).
//
// Plain-English Terms for the LotPilot SaaS — dealer-facing (not buyer).
// Mirrors the structure of /privacy/page.tsx so the legal pages share a
// visual + tone language. Not a substitute for a lawyer's review;
// flagged as "draft for early pilots, revise before charging at scale"
// in the footer.

import type { Metadata } from "next";
import Link from "next/link";

export const dynamic = "force-static";

export const metadata: Metadata = {
  title: "Terms of Service — LotPilot",
  description:
    "Plain-English Terms of Service for dealers using LotPilot — what we provide, what you agree to, how billing and cancellation work.",
};

export default function TermsPage() {
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
            Terms of Service
          </h1>
          <p className="mt-2 text-sm text-zinc-500">Last updated: 2026-05-18</p>
        </header>

        <Section title="The short version">
          <p>
            LotPilot is software you use to answer your buyers faster.
            You pay a monthly subscription, you can cancel any time, and
            you are responsible for what you send to your buyers. We are
            responsible for the software working as described and for
            protecting your data the way we promise in our{" "}
            <Link href="/privacy" className="underline hover:text-zinc-700">
              Privacy
            </Link>{" "}
            page.
          </p>
        </Section>

        <Section title="Who these terms are between">
          <p>
            These Terms are an agreement between you (&ldquo;Dealer&rdquo;
            or &ldquo;you&rdquo;) and LotPilot (&ldquo;we,&rdquo;
            &ldquo;us&rdquo;). By creating an account or letting LotPilot
            answer messages on your behalf, you agree to these Terms.
          </p>
        </Section>

        <Section title="What we provide">
          <ul className="ml-5 list-disc space-y-1.5">
            <li>
              An AI sales assistant that drafts and (with your approval
              or in auto-send mode) sends replies to buyers across web
              chat, SMS, WhatsApp, Facebook Marketplace, and voice.
            </li>
            <li>
              A dashboard to review conversations, track lead status,
              run compliance exports, and configure your dealership.
            </li>
            <li>
              Background automation — Calendly auto-confirm reminders,
              post-test-drive follow-up cadences, outbound re-engagement
              on new inventory, and an inventory acquisition signal — all
              subject to the consent and rate-limit gates described in
              our{" "}
              <Link href="/privacy" className="underline hover:text-zinc-700">
                Privacy
              </Link>{" "}
              page.
            </li>
            <li>
              Software updates. New features ship continuously. We may
              add, change, or remove features over time. If we remove
              something you actively rely on, we will email you first.
            </li>
          </ul>
        </Section>

        <Section title="What we do not provide">
          <ul className="ml-5 list-disc space-y-1.5">
            <li>
              A dealership management system (DMS). LotPilot integrates
              with the channels you already use; it does not replace your
              inventory or finance back-office.
            </li>
            <li>
              Legal, financial, or compliance advice. We help you stay
              TCPA-aware by enforcing consent + STOP/HELP at the
              software layer, but the legal responsibility for what your
              dealership sends remains yours.
            </li>
            <li>
              Outcomes. The AI replies on your behalf — but closed deals,
              units sold, and dealer reputation are yours to own.
            </li>
          </ul>
        </Section>

        <Section title="Your account and what you agree to">
          <ul className="ml-5 list-disc space-y-1.5">
            <li>
              You will provide accurate dealership info and keep your
              login credentials private. You are responsible for activity
              under your account.
            </li>
            <li>
              You will only use LotPilot for lawful, dealership-related
              outreach. No spam blasts, no buying email lists, no
              outreach to people who have not opted in via a LotPilot
              channel.
            </li>
            <li>
              You will respect every STOP, NO, and revocation a buyer
              sends. The software enforces this at the channel level,
              but you must not work around it.
            </li>
            <li>
              You will not reverse-engineer, resell, white-label, or
              sublicense LotPilot without written permission.
            </li>
            <li>
              You are responsible for keeping your inventory data current
              if you want the AI replies to be accurate.
            </li>
          </ul>
        </Section>

        <Section title="Billing">
          <ul className="ml-5 list-disc space-y-1.5">
            <li>
              Subscriptions are billed monthly per dealership in advance.
              Pricing is shown on{" "}
              <Link href="/#pricing" className="underline hover:text-zinc-700">
                our pricing page
              </Link>{" "}
              at the time you sign up.
            </li>
            <li>
              Pilot accounts: the first 30 days are free with no credit
              card required. Anthropic spend is hard-capped per dealer
              during pilots.
            </li>
            <li>
              Cancellation: you can cancel any time from the billing
              portal or by emailing us. Your access continues through
              the end of the paid period; we do not pro-rate refunds for
              partial months.
            </li>
            <li>
              Failed payments: if a charge fails, we keep your account
              active for 7 days while we retry. After 7 days of past-due
              status, AI replies and outbound automation pause until
              billing is fixed; your historical conversations remain
              readable.
            </li>
            <li>
              Taxes: prices do not include sales tax where applicable.
              You are responsible for tax compliance in your
              jurisdiction.
            </li>
            <li>
              Price changes: we may change pricing for renewal periods
              with at least 30 days&apos; notice via email.
            </li>
          </ul>
        </Section>

        <Section title="Data and ownership">
          <ul className="ml-5 list-disc space-y-1.5">
            <li>
              Your conversations, buyer contacts, and inventory data are
              yours. We do not sell them and we do not use them to train
              any AI model.
            </li>
            <li>
              You grant us a limited license to host, process, and
              transmit your data only as needed to provide the service.
            </li>
            <li>
              When you cancel, you can export your data as CSV from the
              compliance page. We delete your active data 90 days after
              cancellation, except where regulator-mandated retention
              applies (TCPA audit records).
            </li>
            <li>
              See{" "}
              <Link href="/privacy" className="underline hover:text-zinc-700">
                our Privacy page
              </Link>{" "}
              for the full data lifecycle.
            </li>
          </ul>
        </Section>

        <Section title="Compliance the software enforces">
          <ul className="ml-5 list-disc space-y-1.5">
            <li>
              Buyer-side consent is captured on the first turn of every
              new conversation and stamped to an append-only audit row.
            </li>
            <li>
              STOP, HELP, START keywords (and Spanish equivalents) are
              detected globally and handled before any AI generation.
            </li>
            <li>
              Outbound re-engagement is rate-limited to a per-dealer cap
              and never sends to suppressed contacts.
            </li>
            <li>
              The compliance CSV export covers the last 90 days and is
              one-click from the dashboard.
            </li>
          </ul>
        </Section>

        <Section title="Service availability and warranty">
          <p>
            We aim for 99.5% monthly uptime. We do not guarantee
            uninterrupted service. The service is provided on an
            &ldquo;as-is&rdquo; basis without warranties beyond what
            applicable law requires. If a feature is broken in a way
            that materially affects your dealership, email us and we
            will fix it.
          </p>
        </Section>

        <Section title="Limitation of liability">
          <p>
            To the maximum extent permitted by law, our total liability
            in any 12-month period is capped at the amount you paid us
            in that period. We are not liable for indirect, incidental,
            or consequential damages (lost profits, lost deals, lost
            data beyond what is recoverable from our backups).
          </p>
        </Section>

        <Section title="Ending the agreement">
          <ul className="ml-5 list-disc space-y-1.5">
            <li>
              You may cancel any time. See the &ldquo;Billing&rdquo;
              section above.
            </li>
            <li>
              We may suspend or end your account if you materially
              breach these Terms (spam, TCPA violations, payment fraud).
              We will email you first when feasible.
            </li>
            <li>
              Sections that should survive cancellation (data ownership,
              billing for completed periods, limitation of liability) do
              survive.
            </li>
          </ul>
        </Section>

        <Section title="Changes to these terms">
          <p>
            We may update these Terms when we ship material changes to
            the service. We will email active customers at least 14
            days before significant changes take effect. Continuing to
            use the service after the effective date means you accept
            the update.
          </p>
        </Section>

        <Section title="Contact">
          <p>
            Questions:{" "}
            <a
              className="underline hover:text-zinc-700"
              href="mailto:hello@lotpilot.app"
            >
              hello@lotpilot.app
            </a>
            . Privacy:{" "}
            <a
              className="underline hover:text-zinc-700"
              href="mailto:privacy@lotpilot.app"
            >
              privacy@lotpilot.app
            </a>
            .
          </p>
        </Section>

        <footer className="mt-12 border-t border-zinc-200 pt-6 text-xs text-zinc-500">
          <p className="mb-2">
            These Terms are a plain-English starting point for early
            pilots. Before scaling to wider distribution, please have a
            lawyer in your jurisdiction review them.
          </p>
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
