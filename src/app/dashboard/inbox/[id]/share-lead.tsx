"use client";

// T4.2 — Inbox-side "Share this lead" UI.
//
// Three-state component:
//   1. idle: a button. Click → expand into the form.
//   2. form: target dealer slug + optional notes + submit / cancel.
//   3. status: shows the result (ok or one of the friendly TCPA gate
//      error messages from actions.ts). After ok the user sees the
//      lead-share id + a hint that the buyer has been SMS'd; the form
//      collapses but stays available for retry if needed.
//
// Why a slug-only input (no autocomplete) in MVP: the network is small
// and dealers contact each other out-of-band before sharing. A picker
// over the dealers table would leak dealer existence to anyone with
// an account — we'll add it in v0.7.4 as an opt-in directory.

import { useState, useTransition } from "react";
import { shareLead, type LeadShareActionState } from "../actions";

interface Props {
  conversationId: string;
  // Tells the user upfront WHY the share button might be disabled.
  // We compute these flags server-side from the conversation row so
  // we don't bother the user with a click that's guaranteed to fail.
  disabledReason: string | null;
}

const NOTES_MAX = 500;

export function ShareLead({ conversationId, disabledReason }: Props) {
  const [open, setOpen] = useState(false);
  const [targetSlug, setTargetSlug] = useState("");
  const [notes, setNotes] = useState("");
  const [pending, startTransition] = useTransition();
  const [result, setResult] = useState<LeadShareActionState | null>(null);

  const disabled = Boolean(disabledReason);

  function submit() {
    setResult(null);
    startTransition(async () => {
      const trimmedSlug = targetSlug.trim().toLowerCase();
      if (!trimmedSlug) {
        setResult({ status: "error", message: "Enter a dealer slug." });
        return;
      }
      const res = await shareLead(
        conversationId,
        trimmedSlug,
        notes.trim() ? notes.trim() : null,
      );
      setResult(res);
      if (res.status === "ok") {
        setTargetSlug("");
        setNotes("");
        setOpen(false);
      }
    });
  }

  // Idle button + (read-only) reason badge.
  if (!open) {
    return (
      <div className="flex flex-wrap items-center gap-2">
        <button
          type="button"
          onClick={() => setOpen(true)}
          disabled={disabled}
          className="inline-flex h-8 items-center rounded-md border border-zinc-300 bg-white px-3 text-xs font-semibold text-zinc-900 hover:bg-zinc-50 disabled:cursor-not-allowed disabled:opacity-50"
        >
          Share this lead
        </button>
        {disabled ? (
          <span className="text-[11px] text-zinc-500">{disabledReason}</span>
        ) : null}
        {result ? <ResultLine result={result} /> : null}
      </div>
    );
  }

  // Form state.
  return (
    <div className="grid gap-2 rounded-lg border border-zinc-200 bg-zinc-50 p-3">
      <div className="grid gap-1">
        <label htmlFor={`target-${conversationId}`} className="text-[11px] font-semibold uppercase tracking-wide text-zinc-500">
          Target dealer slug
        </label>
        <input
          id={`target-${conversationId}`}
          type="text"
          value={targetSlug}
          onChange={(e) => setTargetSlug(e.target.value)}
          placeholder="acme-motors"
          autoComplete="off"
          spellCheck={false}
          className="h-9 rounded-md border border-zinc-300 bg-white px-3 text-sm text-zinc-900 focus:border-amber-500 focus:outline-none focus:ring-2 focus:ring-amber-200"
        />
        <p className="text-[11px] text-zinc-500">
          Lowercase, the URL slug they registered with.
        </p>
      </div>
      <div className="grid gap-1">
        <label htmlFor={`notes-${conversationId}`} className="text-[11px] font-semibold uppercase tracking-wide text-zinc-500">
          Notes for target dealer <span className="text-zinc-400">(optional)</span>
        </label>
        <textarea
          id={`notes-${conversationId}`}
          value={notes}
          onChange={(e) => setNotes(e.target.value.slice(0, NOTES_MAX))}
          rows={2}
          placeholder="Buyer's looking for a clean ’19+ truck under $25k."
          className="rounded-md border border-zinc-300 bg-white px-3 py-2 text-sm text-zinc-900 focus:border-amber-500 focus:outline-none focus:ring-2 focus:ring-amber-200"
        />
        <p className="text-[11px] text-zinc-500">{notes.length} / {NOTES_MAX}</p>
      </div>
      <div className="flex items-center gap-2">
        <button
          type="button"
          onClick={submit}
          disabled={pending}
          className="inline-flex h-9 items-center rounded-md bg-zinc-900 px-3 text-xs font-semibold text-white hover:bg-zinc-800 disabled:opacity-60"
        >
          {pending ? "Sending consent SMS…" : "Send consent SMS"}
        </button>
        <button
          type="button"
          onClick={() => {
            setOpen(false);
            setResult(null);
          }}
          disabled={pending}
          className="inline-flex h-9 items-center rounded-md border border-zinc-300 bg-white px-3 text-xs font-semibold text-zinc-900 hover:bg-zinc-50 disabled:opacity-60"
        >
          Cancel
        </button>
        {result ? <ResultLine result={result} /> : null}
      </div>
      <p className="rounded-md bg-amber-50 px-2 py-1 text-[11px] text-amber-800 ring-1 ring-amber-200">
        The buyer will receive an SMS from your number asking for YES / NO
        consent before any conversation is shared. They can decline with NO
        or stop messages entirely with STOP.
      </p>
    </div>
  );
}

function ResultLine({ result }: { result: LeadShareActionState }) {
  if (result.status === "ok") {
    return (
      <span role="status" className="text-[11px] text-emerald-700">
        Consent SMS sent. Waiting on buyer reply.
      </span>
    );
  }
  return (
    <span role="alert" className="text-[11px] text-rose-600">
      {result.message}
    </span>
  );
}
