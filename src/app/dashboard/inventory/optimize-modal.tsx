"use client";

// AI listing-optimizer modal. Per-vehicle, lazy: nothing fires until
// the dealer clicks "Optimize". On open we POST /optimize, render the
// 3 returned variants, and let the dealer copy one + mark it accepted.

import { useState, useTransition } from "react";
import type { ListingSuggestionRow } from "@/lib/db-types";

type Status = "idle" | "loading" | "ready" | "error";

interface Props {
  vehicleId: string;
  vehicleLabel: string;
}

export function OptimizeModal({ vehicleId, vehicleLabel }: Props) {
  const [open, setOpen] = useState(false);
  const [status, setStatus] = useState<Status>("idle");
  const [error, setError] = useState<string | null>(null);
  const [variants, setVariants] = useState<ListingSuggestionRow[]>([]);
  const [acceptedId, setAcceptedId] = useState<string | null>(null);
  const [pending, startTransition] = useTransition();
  const [copiedId, setCopiedId] = useState<string | null>(null);

  function openAndFetch(): void {
    setOpen(true);
    if (status !== "idle" && status !== "error") return; // already loaded
    setStatus("loading");
    setError(null);
    startTransition(async () => {
      const res = await fetch(`/api/dashboard/vehicles/${vehicleId}/optimize`, {
        method: "POST",
      });
      const data = (await res.json().catch(() => null)) as
        | { variants?: ListingSuggestionRow[]; error?: string }
        | null;
      if (!res.ok || !data?.variants) {
        setStatus("error");
        setError(data?.error ?? "Could not generate listings.");
        return;
      }
      setVariants(data.variants);
      const alreadyAccepted = data.variants.find((v) => v.accepted_at);
      if (alreadyAccepted) setAcceptedId(alreadyAccepted.id);
      setStatus("ready");
    });
  }

  function close(): void {
    setOpen(false);
  }

  async function copyVariant(variant: ListingSuggestionRow): Promise<void> {
    const text = `${variant.title}\n\n${variant.description}`;
    try {
      await navigator.clipboard.writeText(text);
      setCopiedId(variant.id);
      setTimeout(() => setCopiedId((c) => (c === variant.id ? null : c)), 2000);
    } catch {
      setError("Browser blocked the clipboard. Copy manually.");
    }
  }

  function pickVariant(variant: ListingSuggestionRow): void {
    setAcceptedId(variant.id);
    startTransition(async () => {
      const res = await fetch(`/api/dashboard/vehicles/${vehicleId}/optimize`, {
        method: "PATCH",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ suggestion_id: variant.id }),
      });
      if (!res.ok) {
        // Roll back optimistic accepted state.
        setAcceptedId(null);
        const data = (await res.json().catch(() => null)) as { error?: string } | null;
        setError(data?.error ?? "Could not save your selection.");
      }
    });
  }

  return (
    <>
      <button
        type="button"
        onClick={openAndFetch}
        className="inline-flex h-8 items-center rounded-md border border-zinc-300 bg-white px-3 text-xs font-semibold text-zinc-700 hover:bg-zinc-50"
      >
        Optimize
      </button>

      {open ? (
        <div
          role="dialog"
          aria-modal="true"
          aria-label={`Optimize listing for ${vehicleLabel}`}
          className="fixed inset-0 z-50 flex items-start justify-center overflow-y-auto bg-zinc-900/40 p-4"
          onClick={close}
        >
          <div
            className="relative my-8 w-full max-w-3xl rounded-2xl bg-white p-6 shadow-xl"
            onClick={(e) => e.stopPropagation()}
          >
            <header className="flex items-start justify-between gap-4">
              <div>
                <h2 className="text-lg font-semibold tracking-tight">Listing optimizer</h2>
                <p className="mt-0.5 text-xs text-zinc-500">{vehicleLabel}</p>
              </div>
              <button
                type="button"
                onClick={close}
                className="rounded-md border border-zinc-200 bg-white px-3 py-1 text-xs font-medium text-zinc-700 hover:bg-zinc-50"
              >
                Close
              </button>
            </header>

            {status === "loading" || pending ? (
              <p className="mt-6 text-sm text-zinc-600">Generating three Marketplace variants…</p>
            ) : null}

            {status === "error" && error ? (
              <p
                role="alert"
                className="mt-4 rounded-md border border-rose-300 bg-rose-50 px-4 py-2 text-sm text-rose-700"
              >
                {error}
              </p>
            ) : null}

            {status === "ready" ? (
              <div className="mt-4 grid gap-4">
                {variants.map((variant, i) => {
                  const accepted = acceptedId === variant.id;
                  const angle = ANGLE_LABELS[i] ?? "Variant";
                  return (
                    <article
                      key={variant.id}
                      className={
                        accepted
                          ? "rounded-xl border-2 border-amber-400 bg-amber-50 p-4"
                          : "rounded-xl border border-zinc-200 bg-white p-4"
                      }
                    >
                      <header className="flex items-baseline justify-between gap-3">
                        <p className="text-[10px] font-semibold uppercase tracking-wider text-zinc-500">
                          {angle}
                        </p>
                        {accepted ? (
                          <span className="rounded-full bg-amber-200 px-2 py-0.5 text-[10px] font-semibold text-amber-900">
                            Picked
                          </span>
                        ) : null}
                      </header>
                      <h3 className="mt-1 text-sm font-semibold text-zinc-900">{variant.title}</h3>
                      <pre className="mt-2 max-h-48 overflow-auto whitespace-pre-wrap rounded-md border border-zinc-200 bg-zinc-50 p-3 font-sans text-xs text-zinc-800">
                        {variant.description}
                      </pre>
                      {variant.photo_order_hint && variant.photo_order_hint.length > 0 ? (
                        <ol className="mt-3 grid gap-1 text-[11px] text-zinc-600">
                          {variant.photo_order_hint.map((hint, j) => (
                            <li key={j}>
                              <span className="font-mono text-[10px] text-zinc-400">{j + 1}.</span> {hint}
                            </li>
                          ))}
                        </ol>
                      ) : null}
                      {variant.rationale ? (
                        <p className="mt-3 text-[11px] italic text-zinc-500">{variant.rationale}</p>
                      ) : null}
                      <div className="mt-3 flex flex-wrap items-center gap-2">
                        <button
                          type="button"
                          onClick={() => copyVariant(variant)}
                          className="inline-flex h-8 items-center rounded-md bg-zinc-900 px-3 text-xs font-semibold text-white hover:bg-zinc-800"
                        >
                          {copiedId === variant.id ? "Copied" : "Copy text"}
                        </button>
                        {!accepted ? (
                          <button
                            type="button"
                            onClick={() => pickVariant(variant)}
                            disabled={pending}
                            className="inline-flex h-8 items-center rounded-md border border-zinc-300 bg-white px-3 text-xs font-medium text-zinc-700 hover:bg-zinc-50 disabled:opacity-60"
                          >
                            Pick this one
                          </button>
                        ) : null}
                      </div>
                    </article>
                  );
                })}
              </div>
            ) : null}
          </div>
        </div>
      ) : null}
    </>
  );
}

const ANGLE_LABELS = ["Price-led", "Feature-led", "Urgency-led"];
