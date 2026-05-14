// Dealer ZIP3 benchmark tile. Server component — reads
// dealer_zip_benchmarks (the view enforces the 3-dealer privacy floor
// in SQL HAVING, so anything we get back is safe to render).
//
// We display two-up: the dealer's own number vs. the median across
// the ZIP3 cohort. We compute a rough percentile from those two
// scalars (above/below median); v0.7 will add a real percentile
// column to the view.
//
// Empty result: privacy floor hit. We show a friendly stub instead of
// numbers so the dealer knows the feature is alive but waiting for
// more peers — does double duty as a soft growth flywheel.

import { createServerSupabase } from "@/lib/supabase-server";
import type { DealerZipBenchmarkRow } from "@/lib/db-types";

interface BenchmarkTileProps {
  dealerId: string;
}

export async function BenchmarkTile({ dealerId }: BenchmarkTileProps) {
  const sb = await createServerSupabase();
  const { data, error } = await sb
    .from("dealer_zip_benchmarks")
    .select("*")
    .eq("dealer_id", dealerId)
    .maybeSingle();

  // Two empty branches: error and no-row. The privacy floor returns
  // 0 rows naturally; we treat both as "no data yet".
  if (error || !data) {
    return (
      <section className="rounded-2xl border border-zinc-200 bg-white p-5">
        <header className="grid gap-1">
          <p className="text-xs uppercase tracking-widest text-zinc-500">Benchmark</p>
          <h2 className="text-sm font-semibold tracking-tight">
            Your ZIP vs peers
          </h2>
        </header>
        <p className="mt-3 text-xs text-zinc-600">
          Not enough dealers in your area yet — we&rsquo;ll show this
          when 2+ peers join your ZIP3 (privacy floor 3).
        </p>
      </section>
    );
  }

  const row = data as DealerZipBenchmarkRow;
  const mine = row.median_response_sec;
  const zipMedian = row.zip_median_response_sec;
  const mineConv = row.conversion_rate;
  const zipConv = row.zip_median_conversion;

  return (
    <section className="rounded-2xl border border-zinc-200 bg-white p-5">
      <header className="flex items-center justify-between">
        <div>
          <p className="text-xs uppercase tracking-widest text-zinc-500">Benchmark</p>
          <h2 className="text-sm font-semibold tracking-tight">
            ZIP {row.zip3}xx · {row.dealer_count} dealers
          </h2>
        </div>
      </header>
      <div className="mt-4 grid grid-cols-2 gap-4 text-sm">
        <BenchmarkPair
          label="Median response (sec)"
          mine={mine}
          peer={zipMedian}
          lowerIsBetter
        />
        <BenchmarkPair
          label="Conversion rate"
          mine={mineConv}
          peer={zipConv}
          lowerIsBetter={false}
          format="percent"
        />
      </div>
    </section>
  );
}

function BenchmarkPair({
  label,
  mine,
  peer,
  lowerIsBetter,
  format,
}: {
  label: string;
  mine: number | null;
  peer: number | null;
  lowerIsBetter: boolean;
  format?: "percent";
}) {
  const fmt = (v: number | null) => {
    if (v == null) return "—";
    if (format === "percent") return `${Math.round(v * 100)}%`;
    return v < 60 ? `${Math.round(v)}s` : `${(v / 60).toFixed(1)}m`;
  };
  let tag: { label: string; cls: string } | null = null;
  if (mine != null && peer != null) {
    const better = lowerIsBetter ? mine < peer : mine > peer;
    tag = better
      ? { label: "above peers", cls: "bg-emerald-100 text-emerald-800" }
      : mine === peer
        ? { label: "median", cls: "bg-zinc-100 text-zinc-700" }
        : { label: "below peers", cls: "bg-amber-100 text-amber-800" };
  }
  return (
    <div className="grid gap-1">
      <span className="text-xs text-zinc-500">{label}</span>
      <div className="flex items-baseline justify-between">
        <span className="text-lg font-semibold tracking-tight text-zinc-900">{fmt(mine)}</span>
        {tag ? (
          <span className={`rounded-full px-2 py-0.5 text-[10px] font-semibold ${tag.cls}`}>
            {tag.label}
          </span>
        ) : null}
      </div>
      <span className="text-[10px] uppercase tracking-wide text-zinc-500">
        Peer median: {fmt(peer)}
      </span>
    </div>
  );
}
