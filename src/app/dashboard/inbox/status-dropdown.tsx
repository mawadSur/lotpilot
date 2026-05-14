"use client";

import { useState, useTransition } from "react";
import { updateConversation } from "./actions";
import type { LeadStatus } from "@/lib/db-types";

const OPTIONS: { value: LeadStatus; label: string }[] = [
  { value: "new", label: "New" },
  { value: "qualified", label: "Qualified" },
  { value: "booked", label: "Booked" },
  { value: "sold", label: "Sold" },
  { value: "lost", label: "Lost" },
];

interface Props {
  conversationId: string;
  initialStatus: LeadStatus;
  compact?: boolean;
}

export function StatusDropdown({ conversationId, initialStatus, compact = false }: Props) {
  const [status, setStatus] = useState<LeadStatus>(initialStatus);
  const [pending, startTransition] = useTransition();
  const [error, setError] = useState<string | null>(null);

  return (
    <div className="inline-flex items-center gap-2">
      <label className="sr-only" htmlFor={`status-${conversationId}`}>
        Lead status
      </label>
      <select
        id={`status-${conversationId}`}
        value={status}
        disabled={pending}
        onChange={(e) => {
          const next = e.target.value as LeadStatus;
          const prev = status;
          setStatus(next);
          setError(null);
          startTransition(async () => {
            const res = await updateConversation(conversationId, { lead_status: next });
            if (res.status === "error") {
              setStatus(prev);
              setError(res.message);
            }
          });
        }}
        onClick={(e) => {
          // Stop the surrounding <Link> from navigating when the user
          // opens the select inside an inbox row.
          e.stopPropagation();
        }}
        className={
          compact
            ? "h-7 rounded-md border border-zinc-300 bg-white px-2 text-xs text-zinc-900 focus:border-amber-500 focus:outline-none focus:ring-2 focus:ring-amber-200"
            : "h-9 rounded-md border border-zinc-300 bg-white px-2 text-sm text-zinc-900 focus:border-amber-500 focus:outline-none focus:ring-2 focus:ring-amber-200"
        }
      >
        {OPTIONS.map((opt) => (
          <option key={opt.value} value={opt.value}>
            {opt.label}
          </option>
        ))}
      </select>
      {pending ? <span className="text-[10px] text-zinc-400">Saving</span> : null}
      {error ? (
        <span role="alert" className="text-[10px] text-rose-600">
          {error}
        </span>
      ) : null}
    </div>
  );
}
