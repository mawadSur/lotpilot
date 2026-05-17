// T3.2 — GET /api/dashboard/acquisition-signal
//
// Returns the authenticated dealer's top-N (make, model) acquisition
// targets for the last 30 days. Authenticated server client only —
// RLS does the dealer scoping (the underlying view has
// security_invoker=on).

import { NextResponse } from "next/server";
import { requireDealer } from "@/lib/auth";
import { createServerSupabase } from "@/lib/supabase-server";
import {
  fetchAcquisitionSignals,
  DEFAULT_TILE_ROWS,
  MAX_EXPORT_ROWS,
} from "@/lib/acquisition/rank";
import { log } from "@/lib/log";

export const dynamic = "force-dynamic";

export async function GET(request: Request): Promise<NextResponse> {
  // requireDealer redirects on unauthenticated; for an API JSON route
  // that's a bad UX, but matches the existing /api/dashboard/*
  // patterns (which all rely on requireDealer's redirect for the
  // non-auth case). The destructure pulls the DealerRow out of the
  // DealerContext.
  const { dealer } = await requireDealer();

  const url = new URL(request.url);
  const limitParam = url.searchParams.get("limit");
  // Clamp to [1, MAX_EXPORT_ROWS]; non-numeric → default.
  const parsed = Number.parseInt(limitParam ?? "", 10);
  const limit = Number.isFinite(parsed)
    ? Math.max(1, Math.min(parsed, MAX_EXPORT_ROWS))
    : DEFAULT_TILE_ROWS;

  const sb = await createServerSupabase();
  const { signals, error } = await fetchAcquisitionSignals({ sb, limit });
  if (error) {
    log.error("acquisition_signal.fetch_failed", {
      dealer_id: dealer.id,
      detail: error,
    });
    return NextResponse.json({ error: "fetch_failed" }, { status: 500 });
  }
  return NextResponse.json({ signals }, { status: 200 });
}
