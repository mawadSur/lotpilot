"use client";

import Link from "next/link";
import { useState, useTransition } from "react";

interface Props {
  conversationId: string;
  buyerLine: string;
  smsAvailable: boolean; // dealer.sms_number && conversation.buyer_phone && SMS_ENABLED
}

export function ReminderTile({ conversationId, buyerLine, smsAvailable }: Props) {
  const [status, setStatus] = useState<"idle" | "ok" | "error">("idle");
  const [message, setMessage] = useState<string | null>(null);
  const [pending, startTransition] = useTransition();

  function call(channel: "sms" | "copy"): void {
    setStatus("idle");
    setMessage(null);
    startTransition(async () => {
      const res = await fetch(`/api/dashboard/conversations/${conversationId}/reminder`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ channel }),
      });
      const data = (await res.json().catch(() => null)) as
        | { ok?: boolean; error?: string; text?: string; sent?: boolean }
        | null;
      if (!res.ok || !data?.ok) {
        setStatus("error");
        setMessage(data?.error ?? "Could not send.");
        return;
      }
      if (channel === "copy" && data.text) {
        try {
          await navigator.clipboard.writeText(data.text);
          setStatus("ok");
          setMessage("Copied reminder text.");
        } catch {
          setStatus("error");
          setMessage("Could not copy. Browser blocked the clipboard.");
        }
        return;
      }
      setStatus("ok");
      setMessage("Reminder sent.");
    });
  }

  return (
    <div className="grid gap-2 rounded-xl border border-amber-200 bg-amber-50 p-4">
      <div className="flex items-center justify-between gap-2">
        <p className="text-xs font-semibold uppercase tracking-wide text-amber-800">
          Test-drive booked
        </p>
        <Link
          href={`/dashboard/inbox/${conversationId}`}
          className="text-xs font-medium text-amber-800 underline hover:text-amber-900"
        >
          Open thread
        </Link>
      </div>
      <p className="line-clamp-2 text-sm text-zinc-900">{buyerLine}</p>
      <div className="flex flex-wrap items-center gap-2">
        <button
          type="button"
          onClick={() => call("sms")}
          disabled={pending || !smsAvailable}
          className="inline-flex h-8 items-center rounded-md bg-zinc-900 px-3 text-xs font-semibold text-white hover:bg-zinc-800 disabled:cursor-not-allowed disabled:opacity-60"
          title={smsAvailable ? undefined : "SMS not configured for this dealer / buyer"}
        >
          {pending ? "Sending" : "Send via SMS"}
        </button>
        <button
          type="button"
          onClick={() => call("copy")}
          disabled={pending}
          className="inline-flex h-8 items-center rounded-md border border-zinc-300 bg-white px-3 text-xs font-medium text-zinc-700 hover:bg-zinc-50"
        >
          Copy text
        </button>
        {message ? (
          <span
            role="status"
            className={
              status === "error" ? "text-xs text-rose-600" : "text-xs text-emerald-700"
            }
          >
            {message}
          </span>
        ) : null}
      </div>
    </div>
  );
}
