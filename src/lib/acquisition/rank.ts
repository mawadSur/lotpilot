// T3.2 (MVP) — Inventory acquisition signal ranking.
//
// The SQL view `public.acquisition_signal_30d` (migration 0016) does
// the heavy lifting: per (dealer, make, model) it aggregates the last
// 30 days of `conversations.buyer_intent_*` capture against current
// available `vehicles` inventory and emits a composite `score`.
//
// This module is the thin app-side layer that:
//   1. SELECTs from the view via the AUTHENTICATED supabase client so
//      RLS scopes results to the calling dealer (the view inherits
//      security_invoker=on from the migration).
//   2. Coerces postgres numeric (string over wire) to JS number so the
//      tile + CSV serializers don't have to.
//   3. Drops zero-demand rows from the default view (a dealer wants
//      "what to buy", not "what you're already stocked on with no
//      demand"). The CSV export keeps them — useful for an inventory
//      audit, and the dealer expects a complete picture.
//   4. Caps the dashboard tile to N rows (default 10) so the dealer's
//      shopping list fits an auction floor walk.
//
// What this module does NOT do (intentional MVP cuts — see migration
// header for full list):
//   - regional pricing / ACV
//   - body_type-only suggestions (vehicles has no body_type column)
//   - cross-dealer benchmarking ("dealers in your zip3 stocked X")
//   - any write path — the dealer marks "acquired" via the existing
//     CSV upload / DMS sync; nothing in T3.2 mutates state.

import type { SupabaseClient } from "@supabase/supabase-js";
import type { AcquisitionSignalRow } from "../db-types";

// Default number of rows surfaced on the dashboard tile. Picked to fit
// a phone screen + match what a dealer can realistically scout at a
// 2-hour auction. CSV export uses MAX_EXPORT_ROWS instead.
export const DEFAULT_TILE_ROWS = 10;
export const MAX_EXPORT_ROWS = 500;

export interface AcquisitionSignal {
  make: string | null;
  model: string | null;
  demand_count: number;
  hot_count: number;
  warm_count: number;
  cold_count: number;
  inventory_count: number;
  score: number;
}

export interface FetchArgs {
  // Authenticated dealer-scoped supabase client. RLS does the dealer_id
  // filter; we never accept a dealerId arg here so callers can't
  // accidentally request another dealer's signals.
  sb: SupabaseClient;
  limit: number;
  // If true, include rows with demand_count = 0 (existing inventory
  // with no recent demand). CSV export sets this; tile leaves it false.
  includeNoDemand?: boolean;
}

// Normalise the postgres numeric (returns over the wire as string) +
// drop the dealer_id field (RLS already proved this row belongs to the
// caller — no need to leak it into the response).
function normaliseRow(row: AcquisitionSignalRow): AcquisitionSignal {
  return {
    make: row.make,
    model: row.model,
    demand_count: Number(row.demand_count ?? 0),
    hot_count: Number(row.hot_count ?? 0),
    warm_count: Number(row.warm_count ?? 0),
    cold_count: Number(row.cold_count ?? 0),
    inventory_count: Number(row.inventory_count ?? 0),
    score: typeof row.score === "string" ? Number(row.score) : (row.score ?? 0),
  };
}

export async function fetchAcquisitionSignals(
  args: FetchArgs,
): Promise<{ signals: AcquisitionSignal[]; error: string | null }> {
  const cap = Math.max(1, Math.min(args.limit, MAX_EXPORT_ROWS));
  const res = await args.sb
    .from("acquisition_signal_30d")
    .select("make,model,demand_count,hot_count,warm_count,cold_count,inventory_count,score")
    .order("score", { ascending: false })
    .limit(cap);
  if (res.error) {
    return { signals: [], error: res.error.message };
  }
  const rows = (res.data ?? []) as AcquisitionSignalRow[];
  let signals = rows.map(normaliseRow);
  if (!args.includeNoDemand) {
    signals = signals.filter((s) => s.demand_count > 0);
  }
  return { signals, error: null };
}

// CSV serializer for the export route. RFC 4180 minimal — escape
// quotes by doubling, wrap any field with a comma / quote / newline
// in quotes. make / model are lowercase from the SQL view + are
// already constrained at ingest (60 chars max), so the only realistic
// risk is a stray comma in a model name (e.g. "f-150, supercrew" if
// the model captured a trim — we still escape defensively).
export function toCsv(signals: AcquisitionSignal[]): string {
  const header = [
    "make",
    "model",
    "demand_count",
    "hot_count",
    "warm_count",
    "cold_count",
    "inventory_count",
    "score",
  ].join(",");
  const lines = signals.map((s) =>
    [
      csvField(s.make ?? ""),
      csvField(s.model ?? ""),
      String(s.demand_count),
      String(s.hot_count),
      String(s.warm_count),
      String(s.cold_count),
      String(s.inventory_count),
      s.score.toFixed(3),
    ].join(","),
  );
  return [header, ...lines].join("\n") + "\n";
}

function csvField(s: string): string {
  if (s.includes(",") || s.includes('"') || s.includes("\n")) {
    return `"${s.replace(/"/g, '""')}"`;
  }
  return s;
}
