// Marketplace relay: dealer pastes a buyer message from FB Marketplace
// (or anywhere we don't have a native channel for), gets back an AI
// draft they can copy / paste back to the buyer. Server-rendered
// shell + a small client form.

import { requireDealer } from "@/lib/auth";
import { createServerSupabase } from "@/lib/supabase-server";
import type { VehicleRow } from "@/lib/db-types";
import { RelayForm } from "./relay-form";

export const dynamic = "force-dynamic";

export default async function RelayPage() {
  const { dealer } = await requireDealer();
  const sb = await createServerSupabase();
  const { data } = await sb
    .from("vehicles")
    .select("*")
    .eq("dealer_id", dealer.id)
    .eq("status", "available")
    .order("updated_at", { ascending: false })
    .limit(200);

  const vehicles = (data ?? []) as VehicleRow[];

  return (
    <div className="grid gap-6">
      <header>
        <h1 className="text-xl font-semibold tracking-tight">Marketplace relay</h1>
        <p className="text-sm text-zinc-600">
          Paste a buyer message from Facebook Marketplace (or any channel
          we don&rsquo;t talk to directly). We draft the reply in your voice;
          you copy + paste it back.
        </p>
      </header>

      <RelayForm vehicles={vehicles} />
    </div>
  );
}
