// /dashboard/compliance — TCPA / carrier compliance CSV exporter.
//
// Three mutually-exclusive scopes:
//   conversation_ids — comma/newline-separated UUIDs the dealer pastes.
//   date_range       — inclusive start + end ISO date inputs.
//   dealer_wide      — every conversation under this dealer (capped at
//                      10k messages server-side; the dealer is asked to
//                      narrow if they exceed).
//
// The export streams CSV via ReadableStream → no buffered allocations,
// no OOM on 50k-row exports. Authenticated server supabase client is
// used so RLS enforces dealer scoping — service role is NOT used here
// (provable constraint inside the request handler).
//
// Audit row is written to compliance_exports after the stream
// completes (we know row_count by then). 5/day rate limit per dealer
// in the action.

import { requireDealer } from "@/lib/auth";
import { createServerSupabase } from "@/lib/supabase-server";
import { ComplianceForm } from "./compliance-form";
import type { ComplianceExportRow } from "@/lib/db-types";

export const dynamic = "force-dynamic";

export default async function CompliancePage() {
  const { dealer } = await requireDealer();
  const sb = await createServerSupabase();
  const { data } = await sb
    .from("compliance_exports")
    .select("*")
    .eq("dealer_id", dealer.id)
    .order("created_at", { ascending: false })
    .limit(10);
  const history = (data ?? []) as ComplianceExportRow[];

  return (
    <div className="grid gap-6">
      <header className="grid gap-1">
        <h1 className="text-xl font-semibold tracking-tight">Compliance export</h1>
        <p className="text-sm text-zinc-600">
          Download a CSV of conversations + messages + consents + keyword
          events for carrier audits or your own records. Every download
          is logged below.
        </p>
      </header>

      <ComplianceForm />

      <section className="grid gap-2">
        <h2 className="text-sm font-semibold tracking-tight">Export history</h2>
        {history.length === 0 ? (
          <p className="rounded-xl border border-dashed border-zinc-300 bg-white p-4 text-xs text-zinc-600">
            No exports yet.
          </p>
        ) : (
          <ul className="grid gap-1 text-xs text-zinc-700">
            {history.map((row) => (
              <li
                key={row.id}
                className="grid grid-cols-[1fr_auto_auto] items-center gap-3 rounded-md border border-zinc-200 bg-white px-3 py-2"
              >
                <span className="font-mono">{row.scope}</span>
                <span>{row.row_count} rows</span>
                <time dateTime={row.created_at}>
                  {new Date(row.created_at).toLocaleString()}
                </time>
              </li>
            ))}
          </ul>
        )}
      </section>
    </div>
  );
}
