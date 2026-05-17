// LotPilot landing page (v0.8.0).
//
// Pattern: Feature-Rich Showcase + Pricing (per UI Pro Max landing
// search). Why this pattern over the "Enterprise Gateway" default
// from the design-system query: the target audience is INDEPENDENT
// SMB dealers (owner-operators, 20-80 units/month), not enterprise.
// They want concrete features + price + a fast self-serve path,
// NOT a "Contact Sales" mega menu.
//
// Sections (top→bottom, all single-page anchors):
//   1. Sticky nav (logo · features · pricing · demo · sign in · CTA)
//   2. Hero — headline, sub, dual CTA, chat-bubble visual
//   3. Trust strip — channel logos + uptime stat
//   4. Problem — "the 9pm Tuesday problem" (founder voice, condensed)
//   5. Features — 6-card grid
//   6. Live chat example — Spanish buyer → bilingual AI reply
//   7. Acquisition signal teaser — the differentiator
//   8. Compliance — TCPA, append-only audit, regulator-defensible
//   9. Pricing — 3 tiers (Starter / Pro [most popular] / Network)
//  10. FAQ — addresses top objections
//  11. Signup form — dark contrasting section (existing SignupForm)
//  12. Footer
//
// All copy is calibrated to the GTM positioning written in the
// session notes: don't lead with "AI", lead with "we answer your
// Marketplace messages." Anchor against deal loss, not feature count.

import Link from "next/link";
import { LogoMark, Wordmark } from "./logo";
import { SignupForm } from "./signup-form";

export default function Home() {
  return (
    <main className="flex min-h-dvh flex-col bg-[var(--surface-base)] text-[var(--ink-strong)]">
      <Nav />
      <Hero />
      <TrustStrip />
      <Problem />
      <Features />
      <ChatExample />
      <AcquisitionSignal />
      <Compliance />
      <Pricing />
      <Faq />
      <SignupSection />
      <Footer />
    </main>
  );
}

/* ------------------------------------------------------------------ */
/* Nav                                                                 */
/* ------------------------------------------------------------------ */

function Nav() {
  return (
    <header className="sticky top-0 z-40 border-b border-[var(--line-soft)] bg-[var(--surface-base)]/85 backdrop-blur">
      <div className="mx-auto flex h-16 max-w-7xl items-center justify-between px-6">
        <Link href="/" aria-label="LotPilot home" className="cursor-pointer">
          <Wordmark size="md" />
        </Link>
        <nav className="hidden items-center gap-8 text-sm font-medium text-[var(--ink-body)] md:flex">
          <a href="#features" className="cursor-pointer transition hover:text-[var(--brand-primary)]">Features</a>
          <a href="#chat" className="cursor-pointer transition hover:text-[var(--brand-primary)]">Live demo</a>
          <a href="#pricing" className="cursor-pointer transition hover:text-[var(--brand-primary)]">Pricing</a>
          <a href="#compliance" className="cursor-pointer transition hover:text-[var(--brand-primary)]">Compliance</a>
        </nav>
        <div className="flex items-center gap-3">
          <Link
            href="/login"
            className="hidden text-sm font-medium text-[var(--ink-body)] transition hover:text-[var(--brand-primary)] sm:inline cursor-pointer"
          >
            Sign in
          </Link>
          <a
            href="#signup"
            className="inline-flex h-10 items-center rounded-lg bg-[var(--brand-accent)] px-4 text-sm font-semibold text-white shadow-sm transition hover:bg-[var(--brand-accent-strong)] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--brand-accent)] focus-visible:ring-offset-2 cursor-pointer"
          >
            Start free pilot
          </a>
        </div>
      </div>
    </header>
  );
}

/* ------------------------------------------------------------------ */
/* Hero                                                                */
/* ------------------------------------------------------------------ */

function Hero() {
  return (
    <section className="relative overflow-hidden border-b border-[var(--line-soft)] bg-gradient-to-b from-[var(--surface-base)] via-[var(--surface-base)] to-[var(--surface-muted)]">
      {/* Decorative ambient gradient — kept subtle per anti-pattern
          ("no AI purple/pink gradients"). Blue-only, low alpha. */}
      <div
        aria-hidden
        className="pointer-events-none absolute -top-32 left-1/2 h-[420px] w-[820px] -translate-x-1/2 rounded-full bg-[var(--brand-primary)] opacity-[0.07] blur-3xl"
      />
      <div className="mx-auto grid max-w-7xl gap-12 px-6 py-20 sm:py-28 lg:grid-cols-[1.1fr_1fr] lg:items-center">
        <div className="grid gap-6">
          <span className="inline-flex w-fit items-center gap-2 rounded-full border border-[var(--brand-primary)]/25 bg-[var(--brand-primary-soft)] px-3 py-1 text-xs font-semibold uppercase tracking-wider text-[var(--brand-primary-strong)]">
            <span className="h-1.5 w-1.5 rounded-full bg-[var(--brand-primary)]" />
            For independent used-car dealers
          </span>
          <h1 className="text-4xl font-extrabold leading-[1.05] tracking-tight text-[var(--ink-strong)] sm:text-5xl lg:text-6xl">
            Every Marketplace lead, answered in{" "}
            <span className="relative inline-block">
              <span className="relative z-10 text-[var(--brand-primary)]">60 seconds</span>
              <span
                aria-hidden
                className="absolute inset-x-0 bottom-1 h-3 -skew-x-6 bg-[var(--brand-accent)]/25"
              />
            </span>
            <span className="block text-2xl font-semibold text-[var(--ink-muted)] sm:text-3xl lg:text-4xl">
              In English. In Spanish. In your voice.
            </span>
          </h1>
          <p className="max-w-xl text-lg leading-relaxed text-[var(--ink-body)] sm:text-xl">
            The bilingual AI sales assistant for the lot. Replies to Facebook
            Marketplace, SMS, WhatsApp, and your web chat the second a buyer
            messages — qualifies the lead, books the test drive on Calendly,
            and tells you what to buy at this weekend&apos;s auction.
          </p>
          <div className="mt-2 flex flex-col gap-3 sm:flex-row sm:items-center">
            <a
              href="#signup"
              className="inline-flex h-12 items-center justify-center rounded-lg bg-[var(--brand-accent)] px-6 text-base font-semibold text-white shadow-md transition hover:bg-[var(--brand-accent-strong)] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--brand-accent)] focus-visible:ring-offset-2 cursor-pointer"
            >
              Start 30-day free pilot
            </a>
            <a
              href="#chat"
              className="inline-flex h-12 items-center justify-center rounded-lg border border-[var(--line-strong)] bg-white px-6 text-base font-semibold text-[var(--ink-strong)] transition hover:border-[var(--brand-primary)] hover:text-[var(--brand-primary)] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--brand-primary)] focus-visible:ring-offset-2 cursor-pointer"
            >
              See it answer a real buyer →
            </a>
          </div>
          <p className="text-sm text-[var(--ink-muted)]">
            No credit card. Anthropic spend capped per-dealer. Cancel any
            time during the pilot.
          </p>
        </div>

        <HeroChatVisual />
      </div>
    </section>
  );
}

function HeroChatVisual() {
  return (
    <div className="relative">
      <div
        aria-hidden
        className="absolute -inset-4 rounded-3xl bg-gradient-to-tr from-[var(--brand-primary)]/10 via-transparent to-[var(--brand-accent)]/10 blur-xl"
      />
      <div className="relative overflow-hidden rounded-2xl border border-[var(--line-soft)] bg-white shadow-xl">
        <div className="flex items-center justify-between border-b border-[var(--line-soft)] bg-[var(--surface-muted)] px-4 py-3">
          <div className="flex items-center gap-2 text-xs font-semibold uppercase tracking-wider text-[var(--ink-muted)]">
            <span className="inline-flex h-5 items-center rounded bg-[var(--brand-primary-soft)] px-2 text-[10px] font-bold text-[var(--brand-primary-strong)]">
              SMS
            </span>
            Atlanta Auto Mart · 8:42 PM
          </div>
          <span className="inline-flex items-center gap-1 rounded-full bg-emerald-50 px-2 py-0.5 text-[10px] font-semibold text-emerald-700">
            <span className="h-1.5 w-1.5 rounded-full bg-emerald-500" />
            Live
          </span>
        </div>
        <div className="grid gap-3 px-4 py-5">
          <Bubble side="left">
            ¿Sigue disponible el Civic 2019 LX?
          </Bubble>
          <Bubble side="right" timing="47 sec">
            Sí, todavía está disponible. Lo tenemos en $17,990 con 52k millas
            — un solo dueño y con dos llaves. ¿Te gustaría venir mañana a
            verlo? Tengo horarios libres después de las 4pm.
            <span className="mt-2 block text-[10px] font-semibold uppercase tracking-wider text-[var(--brand-primary)]">
              Book here: cal.com/atlanta-auto/test-drive
            </span>
          </Bubble>
          <Bubble side="left">Perfecto, mañana a las 5.</Bubble>
          <div className="mt-1 rounded-lg border border-emerald-200 bg-emerald-50 p-3 text-xs text-emerald-900">
            <div className="flex items-center justify-between">
              <span className="font-semibold">Test drive booked</span>
              <span>Tue 5:00 PM</span>
            </div>
            <p className="mt-1 text-emerald-800/80">
              Lead status moved to <strong>booked</strong>. Auto-confirm SMS
              scheduled for 4:00 PM tomorrow.
            </p>
          </div>
        </div>
      </div>
    </div>
  );
}

function Bubble({
  side,
  children,
  timing,
}: {
  side: "left" | "right";
  children: React.ReactNode;
  timing?: string;
}) {
  const isLeft = side === "left";
  return (
    <div className={`flex ${isLeft ? "justify-start" : "justify-end"}`}>
      <div
        className={
          isLeft
            ? "max-w-[80%] rounded-2xl rounded-bl-sm bg-[var(--surface-subtle)] px-3 py-2 text-sm text-[var(--ink-strong)]"
            : "max-w-[80%] rounded-2xl rounded-br-sm bg-[var(--brand-primary)] px-3 py-2 text-sm text-white"
        }
      >
        <p className="whitespace-pre-wrap">{children}</p>
        {timing ? (
          <p className="mt-1 text-[10px] font-semibold text-blue-100">
            AI · replied in {timing}
          </p>
        ) : null}
      </div>
    </div>
  );
}

/* ------------------------------------------------------------------ */
/* Trust strip                                                         */
/* ------------------------------------------------------------------ */

function TrustStrip() {
  return (
    <section className="border-b border-[var(--line-soft)] bg-[var(--surface-muted)] py-10">
      <div className="mx-auto max-w-7xl px-6">
        <p className="text-center text-xs font-semibold uppercase tracking-[0.2em] text-[var(--ink-soft)]">
          Plugs into the channels your dealership already uses
        </p>
        <ul className="mt-6 grid grid-cols-2 items-center gap-x-6 gap-y-5 sm:grid-cols-3 lg:grid-cols-6">
          {[
            "Facebook Marketplace",
            "Twilio SMS",
            "WhatsApp Business",
            "Calendly",
            "Web chat widget",
            "Vapi voice",
          ].map((label) => (
            <li
              key={label}
              className="flex items-center justify-center text-center text-sm font-semibold text-[var(--ink-muted)]"
            >
              {label}
            </li>
          ))}
        </ul>
      </div>
    </section>
  );
}

/* ------------------------------------------------------------------ */
/* Problem (founder voice)                                             */
/* ------------------------------------------------------------------ */

function Problem() {
  return (
    <section className="border-b border-[var(--line-soft)] bg-[var(--surface-base)] py-20">
      <div className="mx-auto grid max-w-7xl gap-12 px-6 lg:grid-cols-[1fr_1.1fr] lg:items-center">
        <div>
          <p className="text-sm font-semibold uppercase tracking-[0.2em] text-[var(--brand-primary)]">
            The 9pm Tuesday problem
          </p>
          <h2 className="mt-3 text-3xl font-extrabold leading-tight tracking-tight text-[var(--ink-strong)] sm:text-4xl">
            Your buyers don&apos;t shop 9 to 5. Your sales team does.
          </h2>
          <div className="mt-6 grid gap-4 text-lg leading-relaxed text-[var(--ink-body)]">
            <p>
              It&apos;s 9pm on a Tuesday. Three people just messaged your
              Marketplace listing about the same Altima. By the time anyone
              replies in the morning, two of them already bought from the
              dealer who answered first.
            </p>
            <p>
              Independent lots pay <strong>$1,500–$4,000/month</strong> for
              AutoTrader and Cars.com leads they can&apos;t respond to fast
              enough. Meanwhile Marketplace, where the actual buyers are,
              runs on one overworked salesperson&apos;s phone.
            </p>
            <p className="text-[var(--ink-strong)]">
              LotPilot answers the message in 60 seconds, in the buyer&apos;s
              language, in your voice — and queues the draft for your review
              before it ships if you want it that way.
            </p>
          </div>
        </div>
        <StatGrid />
      </div>
    </section>
  );
}

function StatGrid() {
  const stats: { value: string; label: string; sub: string }[] = [
    {
      value: "47s",
      label: "Median reply time",
      sub: "vs 4+ hours from a typical lot",
    },
    {
      value: "EN / ES",
      label: "Bilingual register",
      sub: "Mexican / Latin-American Spanish, not literal translation",
    },
    {
      value: "24/7",
      label: "After-hours capture",
      sub: "the messages you used to miss",
    },
    {
      value: "$1.5K+",
      label: "Average deal saved",
      sub: "Pro tier pays back in one closed lead/mo",
    },
  ];
  return (
    <div className="grid grid-cols-2 gap-4 sm:grid-cols-2">
      {stats.map((s) => (
        <div
          key={s.value}
          className="rounded-2xl border border-[var(--line-soft)] bg-[var(--surface-muted)] p-6 transition hover:border-[var(--brand-primary)]/40 hover:bg-white"
        >
          <p className="font-mono text-3xl font-bold tracking-tight text-[var(--ink-strong)] tabular-nums">
            {s.value}
          </p>
          <p className="mt-2 text-sm font-semibold text-[var(--ink-strong)]">
            {s.label}
          </p>
          <p className="mt-1 text-xs text-[var(--ink-muted)]">{s.sub}</p>
        </div>
      ))}
    </div>
  );
}

/* ------------------------------------------------------------------ */
/* Features grid                                                       */
/* ------------------------------------------------------------------ */

function Features() {
  const items: { title: string; body: string; icon: React.ReactNode }[] = [
    {
      title: "Bilingual AI in your voice",
      body: "Claude Sonnet 4.6 trained on your inventory, your tone, your signature. Auto-detects EN/ES and replies in the buyer's language — Mexican/Latin-American register, not Google Translate.",
      icon: <IconChat />,
    },
    {
      title: "Approve before send",
      body: "Every draft can land in a pending queue. Approve, edit, or reject in two taps. Stay in control while LotPilot does the typing.",
      icon: <IconShield />,
    },
    {
      title: "Calendly + auto-confirm",
      body: "Test drives book straight onto your calendar. We text a friendly confirmation 24 hours before — and a follow-up 2 hours before for the higher-risk no-shows.",
      icon: <IconCalendar />,
    },
    {
      title: "Post-drive follow-up",
      body: "24-hour, 72-hour, and 7-day messages auto-cadenced. Auto-cancelled the moment the buyer replies or you mark the lead sold or lost. Zero spam.",
      icon: <IconClock />,
    },
    {
      title: "Re-engagement on new inventory",
      body: "When a new vehicle hits the lot that matches a cold lead's intent, we send one TCPA-compliant SMS. Capped at 50/dealer/day. Append-only audit.",
      icon: <IconSpark />,
    },
    {
      title: "Auction shopping list",
      body: "Aggregates 30 days of buyer-intent capture and tells you what to look for at Saturday's auction. Nobody else on the market does this.",
      icon: <IconCompass />,
    },
  ];
  return (
    <section
      id="features"
      className="border-b border-[var(--line-soft)] bg-[var(--surface-muted)] py-20"
    >
      <div className="mx-auto max-w-7xl px-6">
        <div className="max-w-2xl">
          <p className="text-sm font-semibold uppercase tracking-[0.2em] text-[var(--brand-primary)]">
            What it does, day one
          </p>
          <h2 className="mt-3 text-3xl font-extrabold leading-tight tracking-tight text-[var(--ink-strong)] sm:text-4xl">
            Six things working for you while you&apos;re on the lot.
          </h2>
          <p className="mt-4 text-lg text-[var(--ink-body)]">
            Each of these is live in production today — not a roadmap promise.
            Turn any of them off per-dealer if you&apos;d rather run manual.
          </p>
        </div>
        <ul className="mt-10 grid gap-5 sm:grid-cols-2 lg:grid-cols-3">
          {items.map((it) => (
            <li
              key={it.title}
              className="group flex flex-col gap-3 rounded-2xl border border-[var(--line-soft)] bg-white p-6 shadow-sm transition hover:-translate-y-0.5 hover:border-[var(--brand-primary)]/30 hover:shadow-md"
            >
              <div className="inline-flex h-11 w-11 items-center justify-center rounded-xl bg-[var(--brand-primary-soft)] text-[var(--brand-primary-strong)]">
                {it.icon}
              </div>
              <h3 className="text-lg font-bold tracking-tight text-[var(--ink-strong)]">
                {it.title}
              </h3>
              <p className="text-sm leading-relaxed text-[var(--ink-body)]">
                {it.body}
              </p>
            </li>
          ))}
        </ul>
      </div>
    </section>
  );
}

/* ------------------------------------------------------------------ */
/* Live chat example (longer, narrative)                              */
/* ------------------------------------------------------------------ */

function ChatExample() {
  return (
    <section
      id="chat"
      className="border-b border-[var(--line-soft)] bg-[var(--surface-base)] py-20"
    >
      <div className="mx-auto max-w-7xl px-6">
        <div className="max-w-2xl">
          <p className="text-sm font-semibold uppercase tracking-[0.2em] text-[var(--brand-primary)]">
            Sounds like you. Not like a bot.
          </p>
          <h2 className="mt-3 text-3xl font-extrabold leading-tight tracking-tight text-[var(--ink-strong)] sm:text-4xl">
            A real buyer thread, on a real lot.
          </h2>
          <p className="mt-4 text-lg text-[var(--ink-body)]">
            Spanish-speaking buyer asks about an F-150 at 9:47 PM. LotPilot
            replies in Mexican register, references the actual stock, books
            the drive on Calendly, and hands the conversation back the
            moment the buyer is ready to talk numbers.
          </p>
        </div>
        <div className="mt-10 overflow-hidden rounded-2xl border border-[var(--line-soft)] bg-white shadow-md">
          <div className="flex items-center justify-between border-b border-[var(--line-soft)] bg-[var(--surface-muted)] px-5 py-3 text-sm">
            <div className="flex items-center gap-2">
              <span className="inline-flex h-6 items-center rounded bg-[var(--brand-primary-soft)] px-2 text-[10px] font-bold text-[var(--brand-primary-strong)]">
                Facebook Marketplace
              </span>
              <span className="font-semibold text-[var(--ink-strong)]">
                Atlanta Auto Mart
              </span>
              <span className="text-[var(--ink-muted)]">· conversation #2814</span>
            </div>
            <span className="hidden text-xs text-[var(--ink-muted)] sm:inline">
              Tue · 9:47 PM
            </span>
          </div>
          <div className="grid gap-3 px-5 py-6 sm:px-8">
            <Bubble side="left">Hola, tienes la F-150 todavía?</Bubble>
            <Bubble side="right" timing="38 sec">
              ¡Hola! Sí, la F-150 2018 XLT con 71k millas todavía está en el
              lote. La tenemos en $24,900 — cabina extendida, 4x4, sin
              accidentes en CarFax. ¿Quieres pasar a verla?
            </Bubble>
            <Bubble side="left">
              Y financiamiento? Tengo crédito mediano.
            </Bubble>
            <Bubble side="right" timing="29 sec">
              Trabajamos con varios prestamistas y normalmente conseguimos
              algo para diferentes situaciones de crédito. Lo mejor es que
              vengas y armamos el paquete contigo en persona. ¿Te queda
              mañana después de las 4?
              <span className="mt-2 block text-[10px] font-semibold uppercase tracking-wider text-[var(--brand-primary)]">
                — Carlos, Atlanta Auto Mart
              </span>
            </Bubble>
            <Bubble side="left">Sí, mañana a las 5pm.</Bubble>
            <div className="mt-2 rounded-xl border border-emerald-200 bg-emerald-50 p-4">
              <div className="flex flex-wrap items-center justify-between gap-2">
                <p className="text-sm font-semibold text-emerald-900">
                  Test drive booked · status: booked
                </p>
                <p className="font-mono text-xs text-emerald-700">
                  Wed 5:00 PM
                </p>
              </div>
              <p className="mt-1 text-xs text-emerald-800/80">
                Auto-confirm SMS scheduled for 4:00 PM. Hot-buyer alert sent
                to closer. Post-drive follow-up cadence (24h / 72h / 7d)
                armed and ready to cancel on first buyer reply.
              </p>
            </div>
          </div>
        </div>
      </div>
    </section>
  );
}

/* ------------------------------------------------------------------ */
/* Acquisition signal (the differentiator)                            */
/* ------------------------------------------------------------------ */

function AcquisitionSignal() {
  return (
    <section className="relative overflow-hidden border-b border-[var(--surface-dark-elevated)] bg-[var(--surface-dark)] py-20 text-[var(--ink-on-dark)]">
      <div
        aria-hidden
        className="pointer-events-none absolute -right-32 top-1/2 h-[420px] w-[420px] -translate-y-1/2 rounded-full bg-[var(--brand-primary)] opacity-25 blur-3xl"
      />
      <div className="mx-auto grid max-w-7xl gap-12 px-6 lg:grid-cols-[1.1fr_1fr] lg:items-center">
        <div className="relative">
          <p className="text-sm font-semibold uppercase tracking-[0.2em] text-[var(--brand-accent)]">
            The auction edge
          </p>
          <h2 className="mt-3 text-3xl font-extrabold leading-tight tracking-tight text-white sm:text-4xl">
            Stop guessing at Saturday&apos;s auction.
          </h2>
          <p className="mt-4 text-lg leading-relaxed text-[var(--ink-on-dark)]">
            Every buyer that messages your lot tells LotPilot what they
            want — make, model, body type. We aggregate the last 30 days
            and score every (make, model) by demand × lead heat ÷ current
            stock. The top of the list is what you should be looking for
            on the auction floor this weekend.
          </p>
          <p className="mt-4 text-base leading-relaxed text-[var(--ink-on-dark-muted)]">
            No other dealer tool connects buyer-intent capture to auction
            acquisition. This is why our Pro-tier dealers stay on annual.
          </p>
        </div>
        <div className="relative overflow-hidden rounded-2xl border border-white/10 bg-[var(--surface-dark-elevated)] shadow-2xl">
          <div className="border-b border-white/10 px-5 py-3">
            <p className="text-xs font-semibold uppercase tracking-wider text-[var(--ink-on-dark-muted)]">
              Auction shopping list · last 30 days
            </p>
          </div>
          <table className="w-full text-sm">
            <thead className="bg-white/5 text-[10px] uppercase tracking-wider text-[var(--ink-on-dark-muted)]">
              <tr>
                <th className="px-5 py-2 text-left">Make · Model</th>
                <th className="px-3 py-2 text-right">Demand</th>
                <th className="px-3 py-2 text-right">Hot</th>
                <th className="px-3 py-2 text-right">In stock</th>
                <th className="px-5 py-2 text-right">Score</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-white/10">
              {[
                { mm: "Toyota · Camry", d: 14, h: 6, s: 0, sc: "30.00" },
                { mm: "Honda · Civic", d: 11, h: 4, s: 1, sc: "11.50" },
                { mm: "Ford · F-150", d: 9, h: 3, s: 0, sc: "15.00" },
                { mm: "Nissan · Altima", d: 8, h: 2, s: 2, sc: "4.00" },
                { mm: "Toyota · Corolla", d: 6, h: 1, s: 0, sc: "7.00" },
              ].map((r) => (
                <tr key={r.mm}>
                  <td className="px-5 py-2 font-semibold text-white">{r.mm}</td>
                  <td className="px-3 py-2 text-right tabular-nums text-[var(--ink-on-dark)]">{r.d}</td>
                  <td className="px-3 py-2 text-right tabular-nums text-[var(--brand-accent)]">{r.h}</td>
                  <td className="px-3 py-2 text-right tabular-nums text-[var(--ink-on-dark-muted)]">{r.s}</td>
                  <td className="px-5 py-2 text-right tabular-nums font-bold text-white">{r.sc}</td>
                </tr>
              ))}
            </tbody>
          </table>
          <div className="flex items-center justify-between border-t border-white/10 px-5 py-3 text-xs text-[var(--ink-on-dark-muted)]">
            <span>Download CSV</span>
            <span className="font-mono">5 / 10 rows shown</span>
          </div>
        </div>
      </div>
    </section>
  );
}

/* ------------------------------------------------------------------ */
/* Compliance                                                          */
/* ------------------------------------------------------------------ */

function Compliance() {
  const items: { title: string; body: string }[] = [
    {
      title: "TCPA-compliant by default",
      body: "Buyer consent captured on first turn. STOP / HELP / START enforced globally. Bilingual consent text. Every consent state stamped to an append-only audit row.",
    },
    {
      title: "Append-only audit trail",
      body: "Outbound messages, compliance exports, lead-share consents, and re-engagement sends all write to append-only tables. No authenticated user can rewrite history.",
    },
    {
      title: "One-click compliance CSV",
      body: "90 days of consent + STOP/HELP/START + every outbound, exported as a streaming CSV. Regulator-defensible the moment you send it.",
    },
    {
      title: "RLS at every read",
      body: "Postgres Row-Level Security scopes every dashboard query to your dealer. Service-role keys are only used by background drainers, never the dashboard.",
    },
  ];
  return (
    <section
      id="compliance"
      className="border-b border-[var(--line-soft)] bg-[var(--surface-muted)] py-20"
    >
      <div className="mx-auto max-w-7xl px-6">
        <div className="max-w-2xl">
          <p className="text-sm font-semibold uppercase tracking-[0.2em] text-[var(--brand-primary)]">
            Built for the people who got burned last time
          </p>
          <h2 className="mt-3 text-3xl font-extrabold leading-tight tracking-tight text-[var(--ink-strong)] sm:text-4xl">
            Compliance isn&apos;t an add-on. It&apos;s the foundation.
          </h2>
          <p className="mt-4 text-lg text-[var(--ink-body)]">
            A single TCPA complaint can cost $1,500–$1,500,000. Most
            dealer-side tools treat consent as a checkbox. We treat it as
            an audit-grade ledger.
          </p>
        </div>
        <ul className="mt-10 grid gap-5 sm:grid-cols-2">
          {items.map((it) => (
            <li
              key={it.title}
              className="flex gap-4 rounded-2xl border border-[var(--line-soft)] bg-white p-6"
            >
              <div className="mt-0.5 inline-flex h-9 w-9 shrink-0 items-center justify-center rounded-lg bg-emerald-50 text-emerald-700">
                <IconCheck />
              </div>
              <div>
                <h3 className="text-base font-bold text-[var(--ink-strong)]">
                  {it.title}
                </h3>
                <p className="mt-1 text-sm leading-relaxed text-[var(--ink-body)]">
                  {it.body}
                </p>
              </div>
            </li>
          ))}
        </ul>
      </div>
    </section>
  );
}

/* ------------------------------------------------------------------ */
/* Pricing                                                             */
/* ------------------------------------------------------------------ */

interface PricingTier {
  name: string;
  price: string;
  blurb: string;
  features: string[];
  cta: string;
  highlight?: boolean;
}

const PRICING: PricingTier[] = [
  {
    name: "Starter",
    price: "$199",
    blurb: "For the solo dealer answering messages on their phone.",
    features: [
      "Web chat widget + SMS (Twilio)",
      "Bilingual AI replies (EN / ES)",
      "Approve-before-send queue",
      "Calendly link injection",
      "Lead status pipeline + inbox",
      "1-click TCPA compliance CSV",
    ],
    cta: "Start free pilot",
  },
  {
    name: "Pro",
    price: "$499",
    blurb: "What most independent lots actually need. Pays for itself in one saved deal.",
    features: [
      "Everything in Starter",
      "WhatsApp Business + Marketplace inbound",
      "Auto-confirm reminders (24h + 2h)",
      "Post-drive follow-up cadence (24h / 72h / 7d)",
      "Outbound re-engagement on new inventory",
      "AI listing optimizer + auto-sync",
      "Auction shopping list (T3.2)",
      "Dealer benchmarking vs ZIP-3 peers",
    ],
    cta: "Start free pilot",
    highlight: true,
  },
  {
    name: "Network",
    price: "$999",
    blurb: "Multi-location dealers and groups joining the lead-share network.",
    features: [
      "Everything in Pro",
      "Lead-share network access",
      "Voice channel (Vapi outbound TTS)",
      "Per-dealer Spanish corpus customization",
      "Priority Slack-based support",
      "Founder Loom every Friday",
    ],
    cta: "Talk to founder",
  },
];

function Pricing() {
  return (
    <section
      id="pricing"
      className="border-b border-[var(--line-soft)] bg-[var(--surface-base)] py-20"
    >
      <div className="mx-auto max-w-7xl px-6">
        <div className="mx-auto max-w-2xl text-center">
          <p className="text-sm font-semibold uppercase tracking-[0.2em] text-[var(--brand-primary)]">
            Pricing
          </p>
          <h2 className="mt-3 text-3xl font-extrabold leading-tight tracking-tight text-[var(--ink-strong)] sm:text-4xl">
            One closed lead a month pays for the year.
          </h2>
          <p className="mt-4 text-lg text-[var(--ink-body)]">
            Flat monthly per dealer. No per-message fees. No setup fee. No
            annual lock-in. Cancel during your 30-day pilot for any reason.
          </p>
        </div>
        <ul className="mt-12 grid gap-5 lg:grid-cols-3">
          {PRICING.map((tier) => (
            <li key={tier.name}>
              <PriceCard tier={tier} />
            </li>
          ))}
        </ul>
        <p className="mt-8 text-center text-sm text-[var(--ink-muted)]">
          White-glove add-on (we run your Marketplace listings): +$999/mo.
          Available on Pro and Network.
        </p>
      </div>
    </section>
  );
}

function PriceCard({ tier }: { tier: PricingTier }) {
  return (
    <div
      className={
        tier.highlight
          ? "relative flex h-full flex-col gap-5 rounded-2xl border-2 border-[var(--brand-primary)] bg-white p-7 shadow-xl"
          : "flex h-full flex-col gap-5 rounded-2xl border border-[var(--line-soft)] bg-white p-7 shadow-sm"
      }
    >
      {tier.highlight ? (
        <span className="absolute -top-3 left-1/2 -translate-x-1/2 rounded-full bg-[var(--brand-accent)] px-3 py-1 text-[10px] font-bold uppercase tracking-wider text-white shadow">
          Most popular
        </span>
      ) : null}
      <div>
        <p className="text-sm font-bold uppercase tracking-wider text-[var(--brand-primary)]">
          {tier.name}
        </p>
        <p className="mt-2 flex items-baseline gap-1 font-mono text-4xl font-bold tabular-nums text-[var(--ink-strong)]">
          {tier.price}
          <span className="font-sans text-base font-medium text-[var(--ink-muted)]">
            /mo per dealer
          </span>
        </p>
        <p className="mt-2 text-sm text-[var(--ink-body)]">{tier.blurb}</p>
      </div>
      <ul className="grid gap-2 text-sm text-[var(--ink-body)]">
        {tier.features.map((f) => (
          <li key={f} className="flex items-start gap-2">
            <span className="mt-0.5 inline-flex h-5 w-5 shrink-0 items-center justify-center rounded-full bg-emerald-50 text-emerald-700">
              <IconCheck small />
            </span>
            {f}
          </li>
        ))}
      </ul>
      <div className="mt-auto pt-2">
        <a
          href="#signup"
          className={
            tier.highlight
              ? "inline-flex h-11 w-full items-center justify-center rounded-lg bg-[var(--brand-accent)] px-4 text-sm font-semibold text-white shadow transition hover:bg-[var(--brand-accent-strong)] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--brand-accent)] focus-visible:ring-offset-2 cursor-pointer"
              : "inline-flex h-11 w-full items-center justify-center rounded-lg border border-[var(--line-strong)] bg-white px-4 text-sm font-semibold text-[var(--ink-strong)] transition hover:border-[var(--brand-primary)] hover:text-[var(--brand-primary)] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--brand-primary)] focus-visible:ring-offset-2 cursor-pointer"
          }
        >
          {tier.cta}
        </a>
      </div>
    </div>
  );
}

/* ------------------------------------------------------------------ */
/* FAQ                                                                 */
/* ------------------------------------------------------------------ */

function Faq() {
  const items: { q: string; a: string }[] = [
    {
      q: "Will the AI say something stupid to my customer?",
      a: "Turn on approve-before-send mode and every draft lands in your queue first. You see it, edit it, or reject it in two taps. The AI never ships without your green light if you don't want it to.",
    },
    {
      q: "Is the Spanish actually good?",
      a: "Yes — Mexican / Latin-American register, not literal Google Translate. We use a founder-curated phrase library that the system prompt pulls from on every Spanish turn. Independent Hispanic dealers test it for us.",
    },
    {
      q: "What does the buyer see?",
      a: "Your dealership name. Your signature line. The reply is in their language. They never know it was AI unless you tell them. The Calendly link is injected automatically on test-drive intent.",
    },
    {
      q: "What happens to my data if I cancel?",
      a: "Your conversations and consent records are yours. Export them as CSV any time from the compliance page. If you cancel, we keep the audit trail for the regulator-required retention period and delete the rest.",
    },
    {
      q: "Do I need new software for my lot?",
      a: "No. LotPilot bolts onto the channels you already use — Facebook Marketplace (via a Chrome extension we install for you), Twilio SMS, WhatsApp Business, Calendly, and a copy-paste web chat widget. We're not a DMS replacement.",
    },
    {
      q: "What's NOT included today?",
      a: "Trade-in valuation (KBB / Manheim MMR) and financing pre-qual (RouteOne / 700Credit) are scaffolded but pending partner credentials. The video generator (Reels / TikTok) is on the roadmap. We don't pitch vapor.",
    },
  ];
  return (
    <section className="border-b border-[var(--line-soft)] bg-[var(--surface-muted)] py-20">
      <div className="mx-auto max-w-4xl px-6">
        <h2 className="text-center text-3xl font-extrabold leading-tight tracking-tight text-[var(--ink-strong)] sm:text-4xl">
          Honest answers to the questions every dealer asks first.
        </h2>
        <dl className="mt-10 grid gap-3">
          {items.map((it) => (
            <details
              key={it.q}
              className="group rounded-xl border border-[var(--line-soft)] bg-white p-5 transition open:shadow-sm"
            >
              <summary className="flex cursor-pointer items-center justify-between gap-4 text-base font-semibold text-[var(--ink-strong)] marker:hidden [&::-webkit-details-marker]:hidden">
                <span>{it.q}</span>
                <span
                  aria-hidden
                  className="inline-flex h-7 w-7 shrink-0 items-center justify-center rounded-full bg-[var(--surface-muted)] text-[var(--ink-muted)] transition group-open:rotate-45 group-open:bg-[var(--brand-primary-soft)] group-open:text-[var(--brand-primary)]"
                >
                  <svg width="14" height="14" viewBox="0 0 24 24" fill="none">
                    <path
                      d="M12 5v14M5 12h14"
                      stroke="currentColor"
                      strokeWidth="2"
                      strokeLinecap="round"
                    />
                  </svg>
                </span>
              </summary>
              <dd className="mt-3 text-sm leading-relaxed text-[var(--ink-body)]">
                {it.a}
              </dd>
            </details>
          ))}
        </dl>
      </div>
    </section>
  );
}

/* ------------------------------------------------------------------ */
/* Signup section (dark, contrasting)                                 */
/* ------------------------------------------------------------------ */

function SignupSection() {
  return (
    <section
      id="signup"
      className="relative overflow-hidden bg-[var(--surface-dark)] py-20 text-[var(--ink-on-dark)]"
    >
      <div
        aria-hidden
        className="pointer-events-none absolute -left-32 -top-32 h-[420px] w-[420px] rounded-full bg-[var(--brand-primary)] opacity-25 blur-3xl"
      />
      <div
        aria-hidden
        className="pointer-events-none absolute -right-32 -bottom-32 h-[420px] w-[420px] rounded-full bg-[var(--brand-accent)] opacity-15 blur-3xl"
      />
      <div className="relative mx-auto grid max-w-5xl gap-10 px-6 lg:grid-cols-[1fr_1.4fr] lg:items-start">
        <div>
          <p className="text-sm font-semibold uppercase tracking-[0.2em] text-[var(--brand-accent)]">
            Start your pilot
          </p>
          <h2 className="mt-3 text-3xl font-extrabold leading-tight tracking-tight text-white sm:text-4xl">
            30 days. No card. Cancel anything.
          </h2>
          <p className="mt-4 text-base leading-relaxed text-[var(--ink-on-dark)]">
            Tell me about your lot. I&apos;ll personally email you within 48
            hours to schedule a 15-minute call. We install the Marketplace
            extension on your phone live on the call so there&apos;s nothing
            for you to set up alone.
          </p>
          <ul className="mt-6 grid gap-3 text-sm text-[var(--ink-on-dark)]">
            <li className="flex items-start gap-2">
              <span className="mt-0.5 inline-flex h-5 w-5 shrink-0 items-center justify-center rounded-full bg-emerald-500/20 text-emerald-400">
                <IconCheck small />
              </span>
              No credit card required for pilot
            </li>
            <li className="flex items-start gap-2">
              <span className="mt-0.5 inline-flex h-5 w-5 shrink-0 items-center justify-center rounded-full bg-emerald-500/20 text-emerald-400">
                <IconCheck small />
              </span>
              Anthropic spend hard-capped per dealer
            </li>
            <li className="flex items-start gap-2">
              <span className="mt-0.5 inline-flex h-5 w-5 shrink-0 items-center justify-center rounded-full bg-emerald-500/20 text-emerald-400">
                <IconCheck small />
              </span>
              Weekly &ldquo;Closes of the Week&rdquo; Loom from the founder
            </li>
          </ul>
        </div>
        <div>
          <SignupForm />
        </div>
      </div>
    </section>
  );
}

/* ------------------------------------------------------------------ */
/* Footer                                                              */
/* ------------------------------------------------------------------ */

function Footer() {
  return (
    <footer className="border-t border-[var(--line-soft)] bg-[var(--surface-base)] py-10">
      <div className="mx-auto flex max-w-7xl flex-col items-start justify-between gap-6 px-6 sm:flex-row sm:items-center">
        <div className="flex items-center gap-3">
          <LogoMark size={28} />
          <div className="text-sm">
            <p className="font-semibold text-[var(--ink-strong)]">LotPilot</p>
            <p className="text-xs text-[var(--ink-muted)]">
              Built for the lot, not the boardroom.
            </p>
          </div>
        </div>
        <ul className="flex flex-wrap items-center gap-x-6 gap-y-2 text-sm text-[var(--ink-muted)]">
          <li>
            <a href="#features" className="cursor-pointer transition hover:text-[var(--brand-primary)]">
              Features
            </a>
          </li>
          <li>
            <a href="#pricing" className="cursor-pointer transition hover:text-[var(--brand-primary)]">
              Pricing
            </a>
          </li>
          <li>
            <a href="#compliance" className="cursor-pointer transition hover:text-[var(--brand-primary)]">
              Compliance
            </a>
          </li>
          <li>
            <Link href="/privacy" className="cursor-pointer transition hover:text-[var(--brand-primary)]">
              Privacy
            </Link>
          </li>
          <li>
            <Link href="/login" className="cursor-pointer transition hover:text-[var(--brand-primary)]">
              Dealer sign in
            </Link>
          </li>
        </ul>
        <p className="text-xs text-[var(--ink-soft)]">
          © {new Date().getFullYear()} LotPilot
        </p>
      </div>
    </footer>
  );
}

/* ------------------------------------------------------------------ */
/* Inline SVG icons (Heroicons-style, no emoji per design system)     */
/* ------------------------------------------------------------------ */

function IconChat() {
  return (
    <svg width="22" height="22" viewBox="0 0 24 24" fill="none" aria-hidden>
      <path
        d="M21 11.5a8.38 8.38 0 0 1-.9 3.8 8.5 8.5 0 0 1-7.6 4.7 8.38 8.38 0 0 1-3.8-.9L3 21l1.9-5.7a8.38 8.38 0 0 1-.9-3.8 8.5 8.5 0 0 1 4.7-7.6 8.38 8.38 0 0 1 3.8-.9h.5a8.48 8.48 0 0 1 8 8v.5z"
        stroke="currentColor"
        strokeWidth="1.8"
        strokeLinecap="round"
        strokeLinejoin="round"
      />
    </svg>
  );
}

function IconShield() {
  return (
    <svg width="22" height="22" viewBox="0 0 24 24" fill="none" aria-hidden>
      <path
        d="M12 22s8-4 8-10V5l-8-3-8 3v7c0 6 8 10 8 10z"
        stroke="currentColor"
        strokeWidth="1.8"
        strokeLinejoin="round"
      />
      <path
        d="m9 12 2 2 4-4"
        stroke="currentColor"
        strokeWidth="1.8"
        strokeLinecap="round"
        strokeLinejoin="round"
      />
    </svg>
  );
}

function IconCalendar() {
  return (
    <svg width="22" height="22" viewBox="0 0 24 24" fill="none" aria-hidden>
      <rect
        x="3"
        y="5"
        width="18"
        height="16"
        rx="2"
        stroke="currentColor"
        strokeWidth="1.8"
      />
      <path
        d="M16 3v4M8 3v4M3 10h18"
        stroke="currentColor"
        strokeWidth="1.8"
        strokeLinecap="round"
      />
    </svg>
  );
}

function IconClock() {
  return (
    <svg width="22" height="22" viewBox="0 0 24 24" fill="none" aria-hidden>
      <circle cx="12" cy="12" r="9" stroke="currentColor" strokeWidth="1.8" />
      <path
        d="M12 7v5l3 2"
        stroke="currentColor"
        strokeWidth="1.8"
        strokeLinecap="round"
      />
    </svg>
  );
}

function IconSpark() {
  return (
    <svg width="22" height="22" viewBox="0 0 24 24" fill="none" aria-hidden>
      <path
        d="M12 3v4M12 17v4M3 12h4M17 12h4M5.6 5.6l2.8 2.8M15.6 15.6l2.8 2.8M5.6 18.4l2.8-2.8M15.6 8.4l2.8-2.8"
        stroke="currentColor"
        strokeWidth="1.8"
        strokeLinecap="round"
      />
    </svg>
  );
}

function IconCompass() {
  return (
    <svg width="22" height="22" viewBox="0 0 24 24" fill="none" aria-hidden>
      <circle cx="12" cy="12" r="9" stroke="currentColor" strokeWidth="1.8" />
      <path
        d="m15 9-2 4-4 2 2-4z"
        stroke="currentColor"
        strokeWidth="1.8"
        strokeLinejoin="round"
      />
    </svg>
  );
}

function IconCheck({ small = false }: { small?: boolean }) {
  const s = small ? 12 : 16;
  return (
    <svg width={s} height={s} viewBox="0 0 24 24" fill="none" aria-hidden>
      <path
        d="m5 12 5 5L20 7"
        stroke="currentColor"
        strokeWidth="2.4"
        strokeLinecap="round"
        strokeLinejoin="round"
      />
    </svg>
  );
}
