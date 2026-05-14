export const dynamic = "force-dynamic";

import Link from "next/link";
import { LoginForm } from "./login-form";

export const metadata = {
  title: "Sign in — LotPilot",
  description: "Sign in to your LotPilot dealer dashboard.",
};

export default function LoginPage() {
  return (
    <main className="min-h-dvh bg-zinc-950 text-zinc-100">
      <div className="mx-auto flex min-h-dvh max-w-md flex-col justify-center gap-8 px-6 py-16">
        <Link
          href="/"
          className="flex items-center gap-2 text-sm font-semibold tracking-wide text-zinc-200 hover:text-amber-300"
        >
          <span className="inline-block h-2.5 w-2.5 rounded-full bg-amber-400 shadow-[0_0_12px_rgba(251,191,36,0.7)]" />
          LotPilot
        </Link>

        <div className="grid gap-2">
          <h1 className="text-3xl font-semibold tracking-tight">
            Sign in to your dealer dashboard
          </h1>
          <p className="text-sm text-zinc-400">
            Enter the email you signed up with. We&apos;ll send you a one-tap
            link — no password.
          </p>
        </div>

        <div className="rounded-2xl border border-white/10 bg-white/[0.03] p-6">
          <LoginForm />
        </div>

        <p className="text-xs text-zinc-500">
          Not on the pilot yet?{" "}
          <Link href="/#signup" className="text-amber-300 hover:underline">
            Join the waitlist
          </Link>
          .
        </p>
      </div>
    </main>
  );
}
