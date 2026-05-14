"use client";

import { useActionState } from "react";
import { useFormStatus } from "react-dom";
import { requestMagicLink, type LoginState } from "./actions";

const initial: LoginState = { status: "idle" };

function SubmitButton() {
  const { pending } = useFormStatus();
  return (
    <button
      type="submit"
      disabled={pending}
      className="inline-flex h-12 w-full items-center justify-center rounded-md bg-amber-400 px-6 text-base font-semibold text-zinc-900 transition hover:bg-amber-300 focus:outline-none focus:ring-2 focus:ring-amber-300 focus:ring-offset-2 focus:ring-offset-zinc-950 disabled:cursor-not-allowed disabled:opacity-60"
    >
      {pending ? "Sending link…" : "Email me a sign-in link"}
    </button>
  );
}

export function LoginForm() {
  const [state, action] = useActionState(requestMagicLink, initial);

  if (state.status === "ok") {
    return (
      <div
        role="status"
        aria-live="polite"
        className="rounded-lg border border-emerald-500/30 bg-emerald-500/10 p-6 text-emerald-100"
      >
        <p className="text-lg font-semibold">Check your inbox.</p>
        <p className="mt-2 text-sm text-emerald-200/80">
          We sent a one-tap sign-in link to <strong>{state.email}</strong>.
          The link expires in 60 minutes.
        </p>
      </div>
    );
  }

  return (
    <form action={action} className="grid gap-4" noValidate>
      <label className="grid gap-1.5 text-sm">
        <span className="font-medium text-zinc-200">Work email</span>
        <input
          type="email"
          name="email"
          required
          maxLength={254}
          autoComplete="email"
          placeholder="you@yourdealership.com"
          className="h-11 rounded-md border border-white/15 bg-zinc-950/60 px-3 text-zinc-100 placeholder-zinc-500 focus:border-amber-400 focus:outline-none focus:ring-2 focus:ring-amber-400/50"
        />
      </label>

      {state.status === "error" ? (
        <p
          role="alert"
          className="rounded-md border border-rose-500/40 bg-rose-500/10 px-4 py-2 text-sm text-rose-200"
        >
          {state.message}
        </p>
      ) : null}

      <SubmitButton />
      <p className="text-xs text-zinc-500">
        We use one-time email links — no passwords to remember or leak.
      </p>
    </form>
  );
}
