"use client";

// v0.4 T2.3 Auto-repost tile. Displays vehicles whose last_listed_at
// is older than the configured cadence (default 5 days) so the dealer
// can re-share them. The list rendering itself is server-side via
// `RepostList` further down; this client wrapper is for the per-row
// action button so the user gets optimistic UI + inline status.
//
// Per-row layout: tiny photo + year/make/model + stock # + age in
// days, two buttons (Mark as reposted / Open optimizer deep link).

import Link from "next/link";
import { useState, useTransition } from "react";
import { markVehicleReposted } from "./repost-actions";

interface RepostRow {
  id: string;
  label: string;
  stockNumber: string;
  daysOld: number;
  preview: string;
  photoUrl: string | null;
}

interface Props {
  rows: RepostRow[];
}

export function RepostTile({ rows }: Props) {
  if (rows.length === 0) return null;
  return (
    <section className="grid gap-3">
      <header className="flex items-center justify-between">
        <h2 className="text-lg font-semibold tracking-tight">Vehicles due for repost</h2>
        <Link
          href="/dashboard/inventory"
          className="text-xs font-medium text-zinc-500 hover:text-zinc-900"
        >
          Open inventory
        </Link>
      </header>
      <ul className="grid gap-3 sm:grid-cols-2">
        {rows.map((r) => (
          <li key={r.id}>
            <RepostRowCard row={r} />
          </li>
        ))}
      </ul>
    </section>
  );
}

function RepostRowCard({ row }: { row: RepostRow }) {
  const [status, setStatus] = useState<"idle" | "ok" | "error">("idle");
  const [message, setMessage] = useState<string | null>(null);
  const [pending, startTransition] = useTransition();

  function onMark(): void {
    setStatus("idle");
    setMessage(null);
    startTransition(async () => {
      const result = await markVehicleReposted(row.id);
      if (result.ok) {
        setStatus("ok");
        setMessage("Marked.");
      } else {
        setStatus("error");
        setMessage(result.error);
      }
    });
  }

  const ageLabel = row.daysOld === 0 ? "Listed today" : `Listed ${row.daysOld} day${row.daysOld === 1 ? "" : "s"} ago`;

  return (
    <div className="flex flex-col gap-2 rounded-xl border border-zinc-200 bg-white p-4">
      <div className="flex items-start gap-3">
        {row.photoUrl ? (
          // eslint-disable-next-line @next/next/no-img-element -- avoid next/image config requirement for arbitrary dealer-uploaded URLs
          <img
            src={row.photoUrl}
            alt=""
            className="h-14 w-20 shrink-0 rounded-md object-cover"
            loading="lazy"
          />
        ) : (
          <div className="h-14 w-20 shrink-0 rounded-md bg-zinc-100" aria-hidden />
        )}
        <div className="min-w-0 flex-1">
          <p className="truncate text-sm font-semibold text-zinc-900">{row.label}</p>
          <p className="text-xs text-zinc-500">
            <span className="font-mono">#{row.stockNumber}</span> · {ageLabel}
          </p>
          {row.preview ? (
            <p className="mt-1 line-clamp-1 text-xs text-zinc-600">{row.preview}</p>
          ) : null}
        </div>
      </div>
      <div className="flex flex-wrap items-center gap-2 pt-1">
        <button
          type="button"
          onClick={onMark}
          disabled={pending}
          className="inline-flex h-8 items-center rounded-md bg-zinc-900 px-3 text-xs font-semibold text-white hover:bg-zinc-800 disabled:opacity-60"
        >
          {pending ? "Saving" : "Mark as reposted"}
        </button>
        <Link
          href={`/dashboard/inventory#vehicle-${row.id}`}
          className="inline-flex h-8 items-center rounded-md border border-zinc-300 bg-white px-3 text-xs font-medium text-zinc-700 hover:bg-zinc-50"
        >
          Open optimizer
        </Link>
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

export type { RepostRow };
