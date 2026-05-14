import { SignupForm } from "./signup-form";

export default function Home() {
  return (
    <main className="min-h-dvh bg-gradient-to-b from-zinc-950 via-zinc-950 to-black text-zinc-100">
      <div className="mx-auto flex max-w-5xl flex-col gap-16 px-6 py-16 sm:py-24">
        <header className="flex items-center justify-between">
          <div className="flex items-center gap-2">
            <span className="inline-block h-2.5 w-2.5 rounded-full bg-amber-400 shadow-[0_0_12px_rgba(251,191,36,0.7)]" />
            <span className="text-sm font-semibold tracking-wide text-zinc-200">
              LotPilot
            </span>
          </div>
          <span className="text-xs uppercase tracking-widest text-zinc-500">
            Private beta
          </span>
        </header>

        <section className="grid gap-6">
          <span className="inline-flex w-fit items-center rounded-full border border-amber-400/30 bg-amber-400/10 px-3 py-1 text-xs font-medium uppercase tracking-wider text-amber-300">
            For independent used-car dealers
          </span>
          <h1 className="text-4xl font-semibold leading-tight tracking-tight sm:text-6xl">
            Every Marketplace lead, answered in&nbsp;
            <span className="text-amber-400">60 seconds.</span>
          </h1>
          <p className="max-w-2xl text-lg text-zinc-300 sm:text-xl">
            LotPilot is the bilingual AI sales assistant that replies to
            every Facebook Marketplace, SMS, and web lead the second it
            lands &mdash; qualifies the buyer, books the test drive, and
            hands off to your team when it&apos;s time to talk numbers.
          </p>
        </section>

        <section className="grid gap-10 lg:grid-cols-2">
          <article className="space-y-4">
            <h2 className="text-sm font-semibold uppercase tracking-widest text-zinc-400">
              The 9pm Tuesday problem
            </h2>
            <p className="text-zinc-300">
              I sold cars for ten years. I know exactly where deals die.
              It&apos;s 9pm on a Tuesday, three people message about the
              same 2018 Altima, and by the time anyone replies the next
              morning, two of them already bought from the dealer who
              answered first.
            </p>
            <p className="text-zinc-300">
              Independent dealers running 20&ndash;150 cars are bleeding
              leads every night and weekend. They pay $1,500&ndash;$4,000
              a month for AutoTrader and Cars.com leads they can&apos;t
              respond to fast enough &mdash; while Marketplace runs on
              one overworked salesperson&apos;s phone.
            </p>
          </article>
          <article className="space-y-4">
            <h2 className="text-sm font-semibold uppercase tracking-widest text-zinc-400">
              What LotPilot does, day one
            </h2>
            <ul className="space-y-3 text-zinc-200">
              <Bullet>
                Answers every Marketplace, SMS, and web lead in under 60
                seconds &mdash; in English or Spanish.
              </Bullet>
              <Bullet>
                Qualifies the buyer (trade-in, financing, timeline, ZIP)
                without sounding like a bot.
              </Bullet>
              <Bullet>
                Books the test drive straight onto your calendar.
              </Bullet>
              <Bullet>
                Hands off to a human the moment the buyer is ready to
                talk numbers.
              </Bullet>
            </ul>
          </article>
        </section>

        <section
          id="signup"
          className="grid gap-6 rounded-2xl border border-white/10 bg-white/[0.03] p-8 sm:p-10"
        >
          <h2 className="text-2xl font-semibold tracking-tight">
            Get on the pilot list
          </h2>
          <p className="text-zinc-300">
            We&apos;re onboarding a small group of independent dealers
            for the first 60 days. Tell me about your lot and I&apos;ll
            personally reach out within 48 hours.
          </p>
          <SignupForm />
        </section>

        <section className="grid gap-4 rounded-xl border border-white/10 bg-white/[0.02] p-6 text-sm text-zinc-300 sm:p-8">
          <h2 className="text-sm font-semibold uppercase tracking-widest text-zinc-400">
            Why this team
          </h2>
          <p>
            LotPilot is built by a 10-year used-car salesperson who has
            answered thousands of Marketplace messages on commission. The
            AI&apos;s voice is the product, and it&apos;s being
            calibrated by someone who knows the difference between the
            phrasing that books a test drive and the phrasing that gets
            ghosted.
          </p>
        </section>

        <footer className="flex flex-col items-start justify-between gap-3 border-t border-white/10 pt-6 text-xs text-zinc-500 sm:flex-row sm:items-center">
          <span>
            &copy; {new Date().getFullYear()} LotPilot. All rights reserved.
          </span>
          <span>Built for the lot, not the boardroom.</span>
        </footer>
      </div>
    </main>
  );
}

function Bullet({ children }: { children: React.ReactNode }) {
  return (
    <li className="flex gap-3">
      <span
        aria-hidden
        className="mt-2 inline-block h-1.5 w-1.5 shrink-0 rounded-full bg-amber-400"
      />
      <span>{children}</span>
    </li>
  );
}
