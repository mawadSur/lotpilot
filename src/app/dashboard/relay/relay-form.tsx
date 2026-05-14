"use client";

import { useActionState, useState } from "react";
import { useFormStatus } from "react-dom";
import Link from "next/link";
import { generateRelayDraft, type RelayState } from "./actions";
import type { VehicleRow } from "@/lib/db-types";

const initial: RelayState = { status: "idle" };

interface Props {
  vehicles: VehicleRow[];
}

export function RelayForm({ vehicles }: Props) {
  const [state, action] = useActionState(generateRelayDraft, initial);
  const [copied, setCopied] = useState<"idle" | "ok" | "error">("idle");

  const draftText =
    state.status === "draft" ? state.draft : "";

  async function copyDraft(): Promise<void> {
    if (!draftText) return;
    try {
      await navigator.clipboard.writeText(draftText);
      setCopied("ok");
    } catch {
      setCopied("error");
    }
    setTimeout(() => setCopied("idle"), 2500);
  }

  return (
    <div className="grid gap-6">
      <form action={action} className="grid gap-4">
        <label className="grid gap-1.5 text-sm">
          <span className="font-medium text-zinc-800">Vehicle (optional)</span>
          <select
            name="vehicle_id"
            defaultValue=""
            className="h-10 rounded-md border border-zinc-300 bg-white px-3 text-sm text-zinc-900 focus:border-amber-500 focus:outline-none focus:ring-2 focus:ring-amber-200"
          >
            <option value="">— none —</option>
            {vehicles.map((v) => (
              <option key={v.id} value={v.id}>
                {describeVehicle(v)}
              </option>
            ))}
          </select>
          <span className="text-xs text-zinc-500">
            Pick the listing the buyer is asking about. The AI will keep its answer
            scoped to that vehicle.
          </span>
        </label>

        <label className="grid gap-1.5 text-sm">
          <span className="font-medium text-zinc-800">Buyer message</span>
          <textarea
            name="buyer_text"
            required
            maxLength={4000}
            rows={6}
            placeholder="Paste the message you got on Marketplace, OfferUp, etc."
            className="rounded-md border border-zinc-300 bg-white px-3 py-2 text-sm text-zinc-900 focus:border-amber-500 focus:outline-none focus:ring-2 focus:ring-amber-200"
          />
        </label>

        <div className="flex items-center gap-3">
          <GenerateButton />
          <span className="text-xs text-zinc-500">
            We never send anything to the buyer. You copy the draft, you paste it back.
          </span>
        </div>

        {state.status === "error" ? (
          <p
            role="alert"
            className="rounded-md border border-rose-300 bg-rose-50 px-4 py-2 text-sm text-rose-700"
          >
            {state.message}
          </p>
        ) : null}
      </form>

      {state.status === "draft" || state.status === "saved" ? (
        <section className="grid gap-3 rounded-2xl border border-zinc-200 bg-white p-5">
          <header className="flex items-center justify-between">
            <h2 className="text-sm font-semibold text-zinc-900">Suggested reply</h2>
            <span className="text-xs text-zinc-500">
              {state.status === "draft" && state.intent
                ? `intent: ${state.intent.replace("_", " ")}`
                : null}
            </span>
          </header>
          <pre className="whitespace-pre-wrap rounded-md border border-zinc-200 bg-zinc-50 p-3 font-sans text-sm text-zinc-900">
            {draftText}
          </pre>
          <div className="flex flex-wrap items-center gap-2">
            <button
              type="button"
              onClick={copyDraft}
              className="inline-flex h-9 items-center rounded-md bg-zinc-900 px-4 text-xs font-semibold text-white hover:bg-zinc-800"
            >
              {copied === "ok" ? "Copied" : copied === "error" ? "Copy failed" : "Copy reply"}
            </button>
            {state.status === "draft" ? (
              <Link
                href={`/dashboard/inbox/${state.conversationId}`}
                className="inline-flex h-9 items-center rounded-md border border-zinc-300 bg-white px-3 text-xs font-medium text-zinc-700 hover:bg-zinc-50"
              >
                Open in inbox
              </Link>
            ) : null}
          </div>
        </section>
      ) : null}
    </div>
  );
}

function GenerateButton() {
  const { pending } = useFormStatus();
  return (
    <button
      type="submit"
      disabled={pending}
      className="inline-flex h-10 items-center justify-center rounded-md bg-zinc-900 px-5 text-sm font-semibold text-white hover:bg-zinc-800 disabled:cursor-not-allowed disabled:opacity-60"
    >
      {pending ? "Drafting…" : "Draft reply"}
    </button>
  );
}

function describeVehicle(v: VehicleRow): string {
  const parts = [v.year, v.make, v.model, v.trim].filter(Boolean).join(" ");
  return `#${v.stock_number}${parts ? ` — ${parts}` : ""}`;
}
