// T3.2 — Inventory acquisition signal tile.
//
// Read-only server component. Renders the top-N (make, model)
// acquisition targets pulled from migration 0016's view. CSV export
// link routes to /api/dashboard/acquisition-signal/export (full set,
// up to MAX_EXPORT_ROWS).
//
// Empty state has its own copy because a dealer with no buyer-intent
// capture yet (early days, or a dealer with low traffic) shouldn't
// see a confusing "0 rows" table — they need to know the signal
// surfaces 30 days of data and is fed by conversations.

import Link from "next/link";
import type { AcquisitionSignal } from "@/lib/acquisition/rank";

interface Props {
  signals: AcquisitionSignal[];
}

export function AcquisitionSignalTile({ signals }: Props) {
  return (
    <section className="grid gap-3">
      <header className="flex items-center justify-between">
        <div>
          <h2 className="text-lg font-semibold tracking-tight">
            Auction shopping list
          </h2>
          <p className="text-xs text-zinc-500">
            What buyers asked about in the last 30 days that you don't have on the lot.
          </p>
        </div>
        <Link
          href="/api/dashboard/acquisition-signal/export"
          className="inline-flex h-9 items-center rounded-md border border-zinc-300 bg-white px-3 text-xs font-semibold text-zinc-900 hover:bg-zinc-50"
          // download attribute hints the browser to save rather than
          // navigate; the response also sets content-disposition.
          download
        >
          Download CSV
        </Link>
      </header>
      {signals.length === 0 ? (
        <EmptyState />
      ) : (
        <div className="overflow-hidden rounded-xl border border-zinc-200 bg-white">
          <table className="w-full text-sm">
            <thead className="bg-zinc-50 text-xs uppercase tracking-wider text-zinc-500">
              <tr>
                <th className="px-4 py-2 text-left">Make · Model</th>
                <th className="px-4 py-2 text-right">Demand (30d)</th>
                <th className="px-4 py-2 text-right">Hot</th>
                <th className="px-4 py-2 text-right">In stock</th>
                <th className="px-4 py-2 text-right">Score</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-zinc-100">
              {signals.map((s, idx) => (
                <tr key={`${s.make}-${s.model}-${idx}`}>
                  <td className="px-4 py-2 font-medium capitalize text-zinc-900">
                    {s.make ?? "—"} {s.model ?? ""}
                  </td>
                  <td className="px-4 py-2 text-right tabular-nums text-zinc-700">
                    {s.demand_count}
                  </td>
                  <td className="px-4 py-2 text-right tabular-nums text-amber-700">
                    {s.hot_count}
                  </td>
                  <td className="px-4 py-2 text-right tabular-nums text-zinc-700">
                    {s.inventory_count}
                  </td>
                  <td className="px-4 py-2 text-right tabular-nums font-semibold text-zinc-900">
                    {s.score.toFixed(2)}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </section>
  );
}

function EmptyState() {
  return (
    <div className="rounded-xl border border-dashed border-zinc-300 bg-white p-6 text-sm text-zinc-600">
      <p className="font-medium text-zinc-900">No demand signal yet.</p>
      <p className="mt-1">
        The shopping list aggregates the make &amp; model your buyers
        asked about in the last 30 days. Once a handful of conversations
        run through the AI, this tile will surface what to look for at
        auction.
      </p>
    </div>
  );
}
