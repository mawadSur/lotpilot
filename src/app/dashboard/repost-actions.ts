"use server";

// v0.4 T2.3 Auto-repost — server action surface. The dashboard tile
// surfaces vehicles whose last_listed_at is older than the configured
// window; clicking "Mark as reposted" calls markVehicleReposted, which
// flips last_listed_at to now() and revalidates the dashboard so the
// vehicle drops out of the tile.
//
// Reviewer guardrail B: this action MUST use the authenticated session
// client (createServerSupabase), NOT the service role. RLS on the
// vehicles table already scopes by dealer ownership; the explicit
// .eq("dealer_id", dealer.id) filter is defense in depth so a future
// RLS regression fails closed instead of leaking the update.

import { revalidatePath } from "next/cache";
import { requireDealer } from "@/lib/auth";
import { createServerSupabase } from "@/lib/supabase-server";
import { log } from "@/lib/log";

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export type MarkRepostedResult = { ok: true } | { ok: false; error: string };

export async function markVehicleReposted(
  vehicleId: string,
): Promise<MarkRepostedResult> {
  if (typeof vehicleId !== "string" || !UUID_RE.test(vehicleId)) {
    return { ok: false, error: "Invalid vehicle id." };
  }

  const { dealer } = await requireDealer();
  const sb = await createServerSupabase();

  const updateRes = await sb
    .from("vehicles")
    .update({ last_listed_at: new Date().toISOString() })
    .eq("id", vehicleId)
    .eq("dealer_id", dealer.id)
    .select("id");

  if (updateRes.error) {
    log.warn("repost.update_failed", {
      dealer_id: dealer.id,
      vehicle_id: vehicleId,
      code: updateRes.error.code,
    });
    return { ok: false, error: "Could not save. Please try again." };
  }
  const rows = (updateRes.data ?? []) as { id: string }[];
  if (rows.length === 0) {
    return { ok: false, error: "Vehicle not found." };
  }

  revalidatePath("/dashboard");
  revalidatePath("/dashboard/inventory");
  return { ok: true };
}
