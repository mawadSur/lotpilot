// T3.2 — GET /api/dashboard/acquisition-signal/export
//
// CSV download of the full acquisition signal (up to MAX_EXPORT_ROWS).
// includeNoDemand=true so the export ALSO shows current inventory with
// zero recent demand — useful as an audit picture, not just a shopping
// list. Authenticated server client; RLS scopes to dealer.

import { type NextRequest } from "next/server";
import { requireDealer } from "@/lib/auth";
import { createServerSupabase } from "@/lib/supabase-server";
import {
  fetchAcquisitionSignals,
  toCsv,
  MAX_EXPORT_ROWS,
} from "@/lib/acquisition/rank";
import { log } from "@/lib/log";

export const dynamic = "force-dynamic";

export async function GET(_request: NextRequest): Promise<Response> {
  const { dealer } = await requireDealer();

  const sb = await createServerSupabase();
  const { signals, error } = await fetchAcquisitionSignals({
    sb,
    limit: MAX_EXPORT_ROWS,
    includeNoDemand: true,
  });
  if (error) {
    log.error("acquisition_signal.export_failed", {
      dealer_id: dealer.id,
      detail: error,
    });
    return new Response("export_failed", { status: 500 });
  }

  const csv = toCsv(signals);
  const today = new Date().toISOString().slice(0, 10);
  return new Response(csv, {
    status: 200,
    headers: {
      "content-type": "text/csv; charset=utf-8",
      "content-disposition": `attachment; filename="acquisition-signal-${today}.csv"`,
      "cache-control": "no-store",
    },
  });
}
