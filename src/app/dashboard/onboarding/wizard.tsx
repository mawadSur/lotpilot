"use client";

import { useActionState } from "react";
import { useFormStatus } from "react-dom";
import { completeOnboarding, type OnboardingState } from "./actions";

const initial: OnboardingState = { status: "idle" };

const DAYS: { key: "mon" | "tue" | "wed" | "thu" | "fri" | "sat" | "sun"; label: string }[] = [
  { key: "mon", label: "Mon" },
  { key: "tue", label: "Tue" },
  { key: "wed", label: "Wed" },
  { key: "thu", label: "Thu" },
  { key: "fri", label: "Fri" },
  { key: "sat", label: "Sat" },
  { key: "sun", label: "Sun" },
];

const DEFAULT_HOURS: Record<(typeof DAYS)[number]["key"], { open: string; close: string; closed: boolean }> = {
  mon: { open: "09:00", close: "19:00", closed: false },
  tue: { open: "09:00", close: "19:00", closed: false },
  wed: { open: "09:00", close: "19:00", closed: false },
  thu: { open: "09:00", close: "19:00", closed: false },
  fri: { open: "09:00", close: "19:00", closed: false },
  sat: { open: "10:00", close: "18:00", closed: false },
  sun: { open: "10:00", close: "16:00", closed: true },
};

const TIMEZONES = [
  "America/New_York",
  "America/Chicago",
  "America/Denver",
  "America/Phoenix",
  "America/Los_Angeles",
  "America/Anchorage",
  "Pacific/Honolulu",
  "America/Puerto_Rico",
];

function SubmitButton() {
  const { pending } = useFormStatus();
  return (
    <button
      type="submit"
      disabled={pending}
      className="inline-flex h-11 items-center justify-center rounded-md bg-zinc-900 px-6 text-sm font-semibold text-white hover:bg-zinc-800 focus:outline-none focus:ring-2 focus:ring-amber-400 disabled:cursor-not-allowed disabled:opacity-60"
    >
      {pending ? "Saving…" : "Finish setup"}
    </button>
  );
}

export function OnboardingWizard({ defaultEmail }: { defaultEmail?: string }) {
  const [state, action] = useActionState(completeOnboarding, initial);

  return (
    <form action={action} className="grid gap-6" noValidate>
      <Section title="Dealership">
        <Field
          label="Dealership name"
          name="name"
          required
          maxLength={200}
          placeholder="Atlanta Auto Mart"
        />
        <Field
          label="Public chat URL"
          name="slug"
          required
          maxLength={40}
          pattern="[a-z0-9](?:[a-z0-9-]{1,38}[a-z0-9])?"
          placeholder="atlanta-auto-mart"
          help="3–40 lowercase letters, numbers, hyphens. Buyers will reach you at /c/<slug>."
          defaultValue={defaultEmail ? slugFromEmail(defaultEmail) : ""}
        />
      </Section>

      <Section title="How replies sign off">
        <label className="grid gap-1.5 text-sm">
          <span className="font-medium text-zinc-800">Signature line</span>
          <input
            type="text"
            name="signature"
            maxLength={500}
            placeholder="— Sam at Atlanta Auto Mart"
            className="h-10 rounded-md border border-zinc-300 bg-white px-3 text-sm text-zinc-900 focus:border-amber-500 focus:outline-none focus:ring-2 focus:ring-amber-200"
          />
          <span className="text-xs text-zinc-500">
            Appears at the end of every AI reply. Leave blank to use the dealership name.
          </span>
        </label>
      </Section>

      <Section title="Business hours">
        <p className="text-xs text-zinc-500">
          The AI mentions hours when relevant (e.g. before suggesting a visit). 24-hour format.
        </p>
        <div className="grid gap-2">
          {DAYS.map(({ key, label }) => (
            <DayRow key={key} dayKey={key} label={label} defaults={DEFAULT_HOURS[key]} />
          ))}
        </div>
      </Section>

      <Section title="Test-drive booking">
        <Field
          label="Calendly URL (optional)"
          name="calendly_url"
          type="url"
          maxLength={500}
          placeholder="https://calendly.com/your-name/test-drive"
          help="If set, the AI shares this link when a buyer asks for a test drive."
        />

        <label className="grid gap-1.5 text-sm">
          <span className="font-medium text-zinc-800">Time zone</span>
          <select
            name="timezone"
            defaultValue="America/New_York"
            className="h-10 rounded-md border border-zinc-300 bg-white px-3 text-sm text-zinc-900 focus:border-amber-500 focus:outline-none focus:ring-2 focus:ring-amber-200"
          >
            {TIMEZONES.map((tz) => (
              <option key={tz} value={tz}>
                {tz}
              </option>
            ))}
          </select>
        </label>
      </Section>

      {state.status === "error" ? (
        <p
          role="alert"
          className="rounded-md border border-rose-300 bg-rose-50 px-4 py-2 text-sm text-rose-700"
        >
          {state.message}
        </p>
      ) : null}

      <SubmitButton />
    </form>
  );
}

function slugFromEmail(email: string): string {
  const local = email.split("@")[0] ?? "";
  return local
    .toLowerCase()
    .replace(/[^a-z0-9-]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 40);
}

function Section({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <section className="grid gap-3 rounded-xl border border-zinc-200 bg-white p-5">
      <h2 className="text-sm font-semibold tracking-tight text-zinc-900">{title}</h2>
      <div className="grid gap-3">{children}</div>
    </section>
  );
}

function Field({
  label,
  name,
  type = "text",
  required,
  maxLength,
  pattern,
  placeholder,
  help,
  defaultValue,
}: {
  label: string;
  name: string;
  type?: string;
  required?: boolean;
  maxLength?: number;
  pattern?: string;
  placeholder?: string;
  help?: string;
  defaultValue?: string;
}) {
  return (
    <label className="grid gap-1.5 text-sm">
      <span className="font-medium text-zinc-800">
        {label}
        {required ? <span className="ml-1 text-amber-600">*</span> : null}
      </span>
      <input
        type={type}
        name={name}
        required={required}
        maxLength={maxLength}
        pattern={pattern}
        placeholder={placeholder}
        defaultValue={defaultValue}
        className="h-10 rounded-md border border-zinc-300 bg-white px-3 text-sm text-zinc-900 focus:border-amber-500 focus:outline-none focus:ring-2 focus:ring-amber-200"
      />
      {help ? <span className="text-xs text-zinc-500">{help}</span> : null}
    </label>
  );
}

function DayRow({
  dayKey,
  label,
  defaults,
}: {
  dayKey: string;
  label: string;
  defaults: { open: string; close: string; closed: boolean };
}) {
  return (
    <fieldset className="grid grid-cols-[3rem_1fr_1fr_auto] items-center gap-2 text-sm">
      <legend className="sr-only">{label}</legend>
      <span className="font-medium text-zinc-700">{label}</span>
      <input
        type="time"
        name={`hours_${dayKey}_open`}
        defaultValue={defaults.open}
        className="h-9 rounded-md border border-zinc-300 bg-white px-2 text-sm focus:border-amber-500 focus:outline-none focus:ring-2 focus:ring-amber-200"
      />
      <input
        type="time"
        name={`hours_${dayKey}_close`}
        defaultValue={defaults.close}
        className="h-9 rounded-md border border-zinc-300 bg-white px-2 text-sm focus:border-amber-500 focus:outline-none focus:ring-2 focus:ring-amber-200"
      />
      <label className="inline-flex items-center gap-1 text-xs text-zinc-600">
        <input
          type="checkbox"
          name={`hours_${dayKey}_closed`}
          defaultChecked={defaults.closed}
          className="h-3.5 w-3.5 rounded border-zinc-300"
        />
        Closed
      </label>
    </fieldset>
  );
}
