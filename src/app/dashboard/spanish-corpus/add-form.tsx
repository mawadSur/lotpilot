"use client";

import { useActionState } from "react";
import { useFormStatus } from "react-dom";
import { addSpanishPhrase, type CorpusState } from "./actions";

const initial: CorpusState = { status: "idle" };

const INTENTS: { value: string; label: string }[] = [
  { value: "general", label: "general" },
  { value: "test_drive", label: "test_drive" },
  { value: "financing", label: "financing" },
  { value: "trade_in", label: "trade_in" },
  { value: "ready_to_close", label: "ready_to_close" },
];

function SaveButton() {
  const { pending } = useFormStatus();
  return (
    <button
      type="submit"
      disabled={pending}
      className="inline-flex h-10 items-center justify-center rounded-md bg-zinc-900 px-5 text-sm font-semibold text-white hover:bg-zinc-800 focus:outline-none focus:ring-2 focus:ring-amber-400 disabled:cursor-not-allowed disabled:opacity-60"
    >
      {pending ? "Adding…" : "Add phrase"}
    </button>
  );
}

export function AddPhraseForm() {
  const [state, action] = useActionState(addSpanishPhrase, initial);

  return (
    <form action={action} className="grid gap-3 rounded-xl border border-zinc-200 bg-white p-4" noValidate>
      <h2 className="text-sm font-semibold">Add phrase</h2>

      <label className="grid gap-1 text-xs">
        <span className="font-medium text-zinc-700">Intent</span>
        <select
          name="intent"
          required
          defaultValue="general"
          className="h-9 rounded-md border border-zinc-300 bg-white px-2 text-sm"
        >
          {INTENTS.map((i) => (
            <option key={i.value} value={i.value}>
              {i.label}
            </option>
          ))}
        </select>
      </label>

      <label className="grid gap-1 text-xs">
        <span className="font-medium text-zinc-700">
          Situation tag <span className="text-zinc-400">(optional, max 60 chars)</span>
        </span>
        <input
          type="text"
          name="situation_tag"
          maxLength={60}
          placeholder="e.g. first-greeting"
          className="h-9 rounded-md border border-zinc-300 px-2 text-sm"
        />
      </label>

      <label className="grid gap-1 text-xs">
        <span className="font-medium text-zinc-700">English (1–600 chars)</span>
        <textarea
          name="en_text"
          required
          maxLength={600}
          rows={2}
          className="rounded-md border border-zinc-300 px-2 py-1.5 text-sm"
        />
      </label>

      <label className="grid gap-1 text-xs">
        <span className="font-medium text-zinc-700">Spanish (1–600 chars)</span>
        <textarea
          name="es_text"
          required
          maxLength={600}
          rows={2}
          className="rounded-md border border-zinc-300 px-2 py-1.5 text-sm"
        />
      </label>

      <div className="flex items-center gap-3">
        <SaveButton />
        {state.status === "ok" ? (
          <span className="text-xs text-emerald-700">{state.message}</span>
        ) : null}
        {state.status === "error" ? (
          <span className="text-xs text-rose-700">{state.message}</span>
        ) : null}
      </div>
    </form>
  );
}
