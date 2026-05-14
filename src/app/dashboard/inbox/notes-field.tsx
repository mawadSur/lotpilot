"use client";

import { useEffect, useRef, useState, useTransition } from "react";
import { updateConversation } from "./actions";

interface Props {
  conversationId: string;
  initialNotes: string;
}

const DEBOUNCE_MS = 800;
const MAX = 4000;

export function NotesField({ conversationId, initialNotes }: Props) {
  const [value, setValue] = useState(initialNotes);
  const [pending, startTransition] = useTransition();
  const [savedAt, setSavedAt] = useState<number | null>(null);
  const [error, setError] = useState<string | null>(null);
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const lastSaved = useRef(initialNotes);

  useEffect(() => {
    if (timer.current) clearTimeout(timer.current);
    if (value === lastSaved.current) return;
    timer.current = setTimeout(() => {
      const snapshot = value;
      startTransition(async () => {
        const res = await updateConversation(conversationId, { notes: snapshot || null });
        if (res.status === "error") {
          setError(res.message);
          return;
        }
        lastSaved.current = snapshot;
        setSavedAt(Date.now());
        setError(null);
      });
    }, DEBOUNCE_MS);
    return () => {
      if (timer.current) clearTimeout(timer.current);
    };
  }, [value, conversationId]);

  const remaining = MAX - value.length;

  return (
    <div className="grid gap-1.5">
      <label htmlFor={`notes-${conversationId}`} className="text-xs font-semibold uppercase tracking-wide text-zinc-500">
        Private notes
      </label>
      <textarea
        id={`notes-${conversationId}`}
        value={value}
        onChange={(e) => setValue(e.target.value.slice(0, MAX))}
        rows={4}
        placeholder="Notes only your team can see — buyer never sees this."
        className="w-full resize-y rounded-md border border-zinc-300 bg-white px-3 py-2 text-sm text-zinc-900 focus:border-amber-500 focus:outline-none focus:ring-2 focus:ring-amber-200"
      />
      <div className="flex items-center justify-between text-[10px] text-zinc-500">
        <span>
          {pending ? "Saving…" : savedAt ? `Saved ${new Date(savedAt).toLocaleTimeString()}` : ""}
          {error ? <span className="ml-2 text-rose-600">{error}</span> : null}
        </span>
        <span>{remaining} chars left</span>
      </div>
    </div>
  );
}
