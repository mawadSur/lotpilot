import { requireDealer } from "@/lib/auth";
import { createServerSupabase } from "@/lib/supabase-server";
import type { VehicleRow } from "@/lib/db-types";
import { CsvUpload } from "./csv-upload";
import { InventoryTable } from "./inventory-table";

export default async function InventoryPage() {
  const { dealer } = await requireDealer();
  const sb = await createServerSupabase();

  const { data } = await sb
    .from("vehicles")
    .select("*")
    .eq("dealer_id", dealer.id)
    .order("updated_at", { ascending: false })
    .limit(500);

  const vehicles = (data ?? []) as VehicleRow[];

  return (
    <div className="grid gap-6">
      <header className="flex items-end justify-between">
        <div>
          <h1 className="text-xl font-semibold tracking-tight">Inventory</h1>
          <p className="text-sm text-zinc-600">
            {vehicles.length} vehicle{vehicles.length === 1 ? "" : "s"} loaded. The AI replies only
            from this list.
          </p>
        </div>
      </header>

      <CsvUpload />
      <InventoryTable vehicles={vehicles} />
    </div>
  );
}
