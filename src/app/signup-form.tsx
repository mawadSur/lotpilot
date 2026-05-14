"use client";

import { useActionState } from "react";
import { useFormStatus } from "react-dom";
import { submitSignup, type SignupState } from "./actions";

const initial: SignupState = { status: "idle" };

function SubmitButton() {
  const { pending } = useFormStatus();
  return (
    <button
      type="submit"
      disabled={pending}
      className="inline-flex h-12 w-full items-center justify-center rounded-md bg-amber-400 px-6 text-base font-semibold text-zinc-900 transition hover:bg-amber-300 focus:outline-none focus:ring-2 focus:ring-amber-300 focus:ring-offset-2 focus:ring-offset-zinc-950 disabled:cursor-not-allowed disabled:opacity-60 sm:w-auto"
    >
      {pending ? "Sending…" : "Got it"}
    </button>
  );
}

export function SignupForm() {
  const [state, action] = useActionState(submitSignup, initial);

  if (state.status === "ok") {
    return (
      <div
        role="status"
        aria-live="polite"
        className="rounded-lg border border-emerald-500/30 bg-emerald-500/10 p-6 text-emerald-100"
      >
        <p className="text-lg font-semibold">
          Thanks — {state.dealership} is on the list.
        </p>
        <p className="mt-2 text-sm text-emerald-200/80">
          I&apos;ll personally email you within 48 hours to set up a
          15-minute call. — Founder, LotPilot
        </p>
      </div>
    );
  }

  return (
    <form
      action={action}
      className="grid gap-4 rounded-xl border border-white/10 bg-white/5 p-6 backdrop-blur sm:p-8"
      noValidate
    >
      <div className="grid gap-4 sm:grid-cols-2">
        <Field
          label="Dealership"
          name="dealership_name"
          placeholder="Atlanta Auto Mart"
          required
          maxLength={200}
        />
        <Field
          label="Your name"
          name="contact_name"
          placeholder="Sam Rivera"
          required
          maxLength={120}
        />
        <Field
          label="Email"
          name="email"
          type="email"
          placeholder="sam@atlantaautomart.com"
          required
          maxLength={254}
        />
        <Field
          label="Phone (optional)"
          name="phone"
          type="tel"
          placeholder="(404) 555-0123"
          maxLength={30}
        />
        <Field
          label="Cars on the lot"
          name="inventory_size"
          type="number"
          placeholder="60"
          min={1}
          max={10000}
        />
        <SelectField
          label="Best channel today"
          name="primary_channel"
          options={[
            { value: "", label: "Select one" },
            { value: "marketplace", label: "Facebook Marketplace" },
            { value: "autotrader", label: "AutoTrader" },
            { value: "cars_com", label: "Cars.com" },
            { value: "website", label: "Our website" },
            { value: "walk_in", label: "Walk-ins" },
            { value: "other", label: "Other" },
          ]}
        />
      </div>

      <label className="grid gap-1.5 text-sm">
        <span className="font-medium text-zinc-200">
          What hurts most right now? (optional)
        </span>
        <textarea
          name="notes"
          rows={3}
          maxLength={2000}
          placeholder="After-hours leads, Spanish-speaking buyers, no-shows on test drives…"
          className="resize-y rounded-md border border-white/15 bg-zinc-950/60 px-3 py-2 text-zinc-100 placeholder-zinc-500 focus:border-amber-400 focus:outline-none focus:ring-2 focus:ring-amber-400/50"
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

      <div className="flex flex-col items-start gap-3 sm:flex-row sm:items-center sm:justify-between">
        <p className="text-xs text-zinc-400">
          No spam. One short email from the founder, then nothing until
          we&apos;re ready for pilots.
        </p>
        <SubmitButton />
      </div>
    </form>
  );
}

type FieldProps = {
  label: string;
  name: string;
  type?: string;
  placeholder?: string;
  required?: boolean;
  maxLength?: number;
  min?: number;
  max?: number;
};

function Field({
  label,
  name,
  type = "text",
  placeholder,
  required,
  maxLength,
  min,
  max,
}: FieldProps) {
  return (
    <label className="grid gap-1.5 text-sm">
      <span className="font-medium text-zinc-200">
        {label}
        {required ? <span className="ml-1 text-amber-400">*</span> : null}
      </span>
      <input
        type={type}
        name={name}
        placeholder={placeholder}
        required={required}
        maxLength={maxLength}
        min={min}
        max={max}
        className="h-11 rounded-md border border-white/15 bg-zinc-950/60 px-3 text-zinc-100 placeholder-zinc-500 focus:border-amber-400 focus:outline-none focus:ring-2 focus:ring-amber-400/50"
      />
    </label>
  );
}

type SelectFieldProps = {
  label: string;
  name: string;
  options: { value: string; label: string }[];
};

function SelectField({ label, name, options }: SelectFieldProps) {
  return (
    <label className="grid gap-1.5 text-sm">
      <span className="font-medium text-zinc-200">{label}</span>
      <select
        name={name}
        defaultValue=""
        className="h-11 rounded-md border border-white/15 bg-zinc-950/60 px-3 text-zinc-100 focus:border-amber-400 focus:outline-none focus:ring-2 focus:ring-amber-400/50"
      >
        {options.map((o) => (
          <option key={o.value} value={o.value} className="bg-zinc-900">
            {o.label}
          </option>
        ))}
      </select>
    </label>
  );
}
