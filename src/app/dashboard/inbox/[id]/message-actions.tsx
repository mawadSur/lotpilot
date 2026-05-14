"use client";

import { useState, useTransition } from "react";
import { useRouter } from "next/navigation";

interface Props {
  messageId: string;
  body: string;
}

const MAX_BODY = 8000;

export function MessageActions({ messageId, body }: Props) {
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState(body);
  const [error, setError] = useState<string | null>(null);
  const [pending, startTransition] = useTransition();
  const router = useRouter();

  function call(path: string, payload?: unknown): void {
    setError(null);
    startTransition(async () => {
      const res = await fetch(path, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(payload ?? {}),
      });
      if (!res.ok) {
        const data = (await res.json().catch(() => null)) as { error?: string } | null;
        setError(data?.error ?? "Action failed.");
        return;
      }
      setEditing(false);
      router.refresh();
    });
  }

  if (editing) {
    return (
      <div className="mt-2 grid gap-2">
        <textarea
          value={draft}
          onChange={(e) => setDraft(e.target.value.slice(0, MAX_BODY))}
          rows={4}
          className="w-full resize-y rounded-md border border-zinc-300 bg-white px-3 py-2 text-xs text-zinc-900 focus:border-amber-500 focus:outline-none focus:ring-2 focus:ring-amber-200"
        />
        <div className="flex flex-wrap items-center gap-2">
          <button
            type="button"
            onClick={() => {
              const text = draft.trim();
              if (!text) {
                setError("Body cannot be empty.");
                return;
              }
              call(`/api/dashboard/messages/${messageId}/edit`, { body: text });
            }}
            disabled={pending}
            className="inline-flex h-8 items-center rounded-md bg-zinc-900 px-3 text-xs font-semibold text-white hover:bg-zinc-800 disabled:cursor-not-allowed disabled:opacity-60"
          >
            {pending ? "Saving" : "Save & approve"}
          </button>
          <button
            type="button"
            onClick={() => {
              setEditing(false);
              setDraft(body);
              setError(null);
            }}
            disabled={pending}
            className="inline-flex h-8 items-center rounded-md border border-zinc-300 bg-white px-3 text-xs font-medium text-zinc-700 hover:bg-zinc-50"
          >
            Cancel
          </button>
          <span className="text-[10px] text-zinc-500">{MAX_BODY - draft.length} chars left</span>
        </div>
        {error ? (
          <p role="alert" className="text-xs text-rose-600">
            {error}
          </p>
        ) : null}
      </div>
    );
  }

  return (
    <div className="mt-2 flex flex-wrap items-center gap-2">
      <button
        type="button"
        onClick={() => call(`/api/dashboard/messages/${messageId}/approve`)}
        disabled={pending}
        className="inline-flex h-8 items-center rounded-md bg-emerald-600 px-3 text-xs font-semibold text-white hover:bg-emerald-700 disabled:cursor-not-allowed disabled:opacity-60"
      >
        Approve
      </button>
      <button
        type="button"
        onClick={() => setEditing(true)}
        disabled={pending}
        className="inline-flex h-8 items-center rounded-md border border-zinc-300 bg-white px-3 text-xs font-medium text-zinc-700 hover:bg-zinc-50"
      >
        Edit
      </button>
      <button
        type="button"
        onClick={() => call(`/api/dashboard/messages/${messageId}/reject`)}
        disabled={pending}
        className="inline-flex h-8 items-center rounded-md border border-rose-300 bg-white px-3 text-xs font-medium text-rose-700 hover:bg-rose-50"
      >
        Reject
      </button>
      {error ? (
        <span role="alert" className="text-xs text-rose-600">
          {error}
        </span>
      ) : null}
    </div>
  );
}
