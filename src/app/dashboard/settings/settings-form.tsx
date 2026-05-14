"use client";

import { useActionState } from "react";
import { useFormStatus } from "react-dom";
import { updateSettings, type SettingsState } from "./actions";
import type { BusinessHoursMap, DealerRow } from "@/lib/db-types";

const initial: SettingsState = { status: "idle" };

const DAYS: { key: keyof BusinessHoursMap; label: string }[] = [
  { key: "mon", label: "Mon" },
  { key: "tue", label: "Tue" },
  { key: "wed", label: "Wed" },
  { key: "thu", label: "Thu" },
  { key: "fri", label: "Fri" },
  { key: "sat", label: "Sat" },
  { key: "sun", label: "Sun" },
];

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

function SaveButton() {
  const { pending } = useFormStatus();
  return (
    <button
      type="submit"
      disabled={pending}
      className="inline-flex h-10 items-center justify-center rounded-md bg-zinc-900 px-5 text-sm font-semibold text-white hover:bg-zinc-800 focus:outline-none focus:ring-2 focus:ring-amber-400 disabled:cursor-not-allowed disabled:opacity-60"
    >
      {pending ? "Saving…" : "Save changes"}
    </button>
  );
}

export function SettingsForm({ dealer }: { dealer: DealerRow }) {
  const [state, action] = useActionState(updateSettings, initial);

  return (
    <form action={action} className="grid gap-6" noValidate>
      <Section title="Dealership">
        <Field
          label="Dealership name"
          name="name"
          required
          maxLength={200}
          defaultValue={dealer.name}
        />
        <ReadOnlyField
          label="Public chat URL"
          value={`/c/${dealer.slug}`}
          help="Slugs are permanent for v0.1 — contact us if you need to change it."
        />
      </Section>

      <Section title="How replies sign off">
        <Field
          label="Signature line"
          name="signature"
          maxLength={500}
          defaultValue={dealer.signature ?? ""}
          placeholder="— Sam at Atlanta Auto Mart"
          help="Appears at the end of every AI reply."
        />
      </Section>

      <Section title="Business hours">
        <div className="grid gap-2">
          {DAYS.map(({ key, label }) => (
            <DayRow
              key={key}
              dayKey={key}
              label={label}
              value={dealer.business_hours[key]}
            />
          ))}
        </div>
      </Section>

      <Section title="Test-drive booking">
        <Field
          label="Calendly URL"
          name="calendly_url"
          type="url"
          maxLength={500}
          defaultValue={dealer.calendly_url ?? ""}
          placeholder="https://calendly.com/your-name/test-drive"
          help="If set, the AI shares this when a buyer asks for a test drive."
        />
        <label className="grid gap-1.5 text-sm">
          <span className="font-medium text-zinc-800">Time zone</span>
          <select
            name="timezone"
            defaultValue={dealer.timezone}
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

      <Section title="SMS (optional)">
        <Field
          label="Dealership SMS number"
          name="sms_number"
          type="tel"
          maxLength={16}
          defaultValue={dealer.sms_number ?? ""}
          placeholder="+14155551212"
          help="E.164 format. Required for the Twilio webhook to route inbound texts to you."
        />
      </Section>

      <Section title="Reply review">
        <label className="flex items-start gap-3 text-sm">
          <input
            type="checkbox"
            name="approve_before_send"
            defaultChecked={dealer.approve_before_send}
            className="mt-1 h-4 w-4 rounded border-zinc-300 text-zinc-900 focus:ring-amber-200"
          />
          <span className="grid gap-1">
            <span className="font-medium text-zinc-800">
              Approve every AI reply before it goes out
            </span>
            <span className="text-xs text-zinc-500">
              When on, buyers see &ldquo;Thanks — the dealer will reply
              shortly&rdquo; and the AI draft sits in your inbox until you
              approve, edit, or reject it. Slower, safer.
            </span>
          </span>
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
      {state.status === "ok" ? (
        <p
          role="status"
          aria-live="polite"
          className="rounded-md border border-emerald-300 bg-emerald-50 px-4 py-2 text-sm text-emerald-700"
        >
          {state.message}
        </p>
      ) : null}

      <SaveButton />
    </form>
  );
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
  defaultValue,
  placeholder,
  help,
}: {
  label: string;
  name: string;
  type?: string;
  required?: boolean;
  maxLength?: number;
  defaultValue?: string;
  placeholder?: string;
  help?: string;
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
        defaultValue={defaultValue}
        placeholder={placeholder}
        className="h-10 rounded-md border border-zinc-300 bg-white px-3 text-sm text-zinc-900 focus:border-amber-500 focus:outline-none focus:ring-2 focus:ring-amber-200"
      />
      {help ? <span className="text-xs text-zinc-500">{help}</span> : null}
    </label>
  );
}

function ReadOnlyField({ label, value, help }: { label: string; value: string; help?: string }) {
  return (
    <div className="grid gap-1.5 text-sm">
      <span className="font-medium text-zinc-800">{label}</span>
      <span className="rounded-md border border-zinc-200 bg-zinc-50 px-3 py-2 font-mono text-sm text-zinc-700">
        {value}
      </span>
      {help ? <span className="text-xs text-zinc-500">{help}</span> : null}
    </div>
  );
}

function DayRow({
  dayKey,
  label,
  value,
}: {
  dayKey: keyof BusinessHoursMap;
  label: string;
  value: [string, string] | null;
}) {
  const open = value ? value[0] : "09:00";
  const close = value ? value[1] : "17:00";
  return (
    <fieldset className="grid grid-cols-[3rem_1fr_1fr_auto] items-center gap-2 text-sm">
      <legend className="sr-only">{label}</legend>
      <span className="font-medium text-zinc-700">{label}</span>
      <input
        type="time"
        name={`hours_${dayKey}_open`}
        defaultValue={open}
        className="h-9 rounded-md border border-zinc-300 bg-white px-2 text-sm focus:border-amber-500 focus:outline-none focus:ring-2 focus:ring-amber-200"
      />
      <input
        type="time"
        name={`hours_${dayKey}_close`}
        defaultValue={close}
        className="h-9 rounded-md border border-zinc-300 bg-white px-2 text-sm focus:border-amber-500 focus:outline-none focus:ring-2 focus:ring-amber-200"
      />
      <label className="inline-flex items-center gap-1 text-xs text-zinc-600">
        <input
          type="checkbox"
          name={`hours_${dayKey}_closed`}
          defaultChecked={value === null}
          className="h-3.5 w-3.5 rounded border-zinc-300"
        />
        Closed
      </label>
    </fieldset>
  );
}
