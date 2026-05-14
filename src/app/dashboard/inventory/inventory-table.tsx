import type { VehicleRow } from "@/lib/db-types";
import { OptimizeModal } from "./optimize-modal";

export function InventoryTable({ vehicles }: { vehicles: VehicleRow[] }) {
  if (vehicles.length === 0) {
    return (
      <p className="rounded-xl border border-dashed border-zinc-300 bg-white p-8 text-center text-sm text-zinc-600">
        No vehicles yet. Upload a CSV above to get started.
      </p>
    );
  }
  return (
    <div className="overflow-hidden rounded-xl border border-zinc-200 bg-white">
      <div className="overflow-x-auto">
        <table className="min-w-full divide-y divide-zinc-200 text-sm">
          <thead className="bg-zinc-50 text-xs uppercase tracking-wider text-zinc-500">
            <tr>
              <Th>Stock #</Th>
              <Th>Vehicle</Th>
              <Th>Mileage</Th>
              <Th>Price</Th>
              <Th>Status</Th>
              <Th>
                <span className="sr-only">Actions</span>
              </Th>
            </tr>
          </thead>
          <tbody className="divide-y divide-zinc-100">
            {vehicles.map((v) => (
              <tr key={v.id}>
                <Td className="font-mono text-xs text-zinc-600">{v.stock_number}</Td>
                <Td>{describeVehicle(v)}</Td>
                <Td className="text-zinc-600">
                  {v.mileage != null ? `${v.mileage.toLocaleString()} mi` : "—"}
                </Td>
                <Td className="text-zinc-900">{formatPrice(v.price_cents)}</Td>
                <Td>
                  <StatusPill status={v.status} />
                </Td>
                <Td className="text-right">
                  <OptimizeModal vehicleId={v.id} vehicleLabel={`#${v.stock_number} ${describeVehicle(v)}`} />
                </Td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </div>
  );
}

function describeVehicle(v: VehicleRow): string {
  const parts = [v.year, v.make, v.model, v.trim].filter((p): p is string | number => p != null);
  return parts.length > 0 ? parts.join(" ") : "—";
}

function formatPrice(cents: number | null): string {
  if (cents == null) return "—";
  return `$${Math.round(cents / 100).toLocaleString()}`;
}

function StatusPill({ status }: { status: VehicleRow["status"] }) {
  const cls =
    status === "available"
      ? "bg-emerald-100 text-emerald-800"
      : status === "pending"
        ? "bg-amber-100 text-amber-800"
        : status === "sold"
          ? "bg-zinc-200 text-zinc-700"
          : "bg-zinc-100 text-zinc-500";
  return (
    <span className={`inline-flex items-center rounded-full px-2 py-0.5 text-[11px] font-medium ${cls}`}>
      {status}
    </span>
  );
}

function Th({ children }: { children: React.ReactNode }) {
  return (
    <th scope="col" className="px-4 py-2 text-left font-semibold">
      {children}
    </th>
  );
}

function Td({ children, className }: { children: React.ReactNode; className?: string }) {
  return <td className={`px-4 py-2 align-top ${className ?? ""}`}>{children}</td>;
}
