// Unresolved-warnings banner. Server component — renders nothing
// when the dealer has no open warnings (most of the time). When
// present, it surfaces a small bar at the top of every dashboard
// page with a count and a link to /dashboard/warnings.
//
// We deliberately do NOT show warning kinds inline here — the banner
// is a presence indicator, not a triage UI. The /dashboard/warnings
// page does the triage.

import Link from "next/link";
import { createServerSupabase } from "@/lib/supabase-server";

export async function WarningsBanner({ dealerId }: { dealerId: string }) {
  const sb = await createServerSupabase();
  const res = await sb
    .from("system_warnings")
    .select("id", { count: "exact", head: true })
    .eq("dealer_id", dealerId)
    .is("resolved_at", null);
  const count = res.count ?? 0;
  if (count <= 0) return null;

  return (
    <div className="border-b border-amber-200 bg-amber-50">
      <div className="mx-auto flex max-w-5xl items-center justify-between gap-3 px-4 py-2 text-xs text-amber-900 sm:px-6">
        <span>
          {count} unresolved warning{count === 1 ? "" : "s"} — Calendly
          mismatches, WhatsApp delivery, or marketplace key disclosures.
        </span>
        <Link
          href="/dashboard/warnings"
          className="rounded-md border border-amber-300 bg-white px-3 py-1 font-semibold text-amber-900 hover:bg-amber-100"
        >
          Review
        </Link>
      </div>
    </div>
  );
}
