// SLA tile: median + p95 first-AI-reply latency, count of replies that
// landed under 60s, and total replies — all over the last 7 days. The
// 7 mini-bars are rendered as inline SVG (no client JS, no chart lib)
// keyed off the per-day reply count from `dashboard_sla_stats`.
//
// Server component. Cached at the page level (revalidate = 60).

import { createServerSupabase } from "@/lib/supabase-server";
import { log } from "@/lib/log";

interface SlaRow {
  day_bucket: string;
  conv_count: number | string;
  under_60s: number | string;
  median_sec: number | string | null;
  p95_sec: number | string | null;
}

interface Aggregate {
  totalReplies: number;
  under60: number;
  medianSec: number | null;
  p95Sec: number | null;
  dailyCounts: number[]; // 7 entries, oldest → newest
  hasData: boolean;
}

const DAYS = 7;

function toNumber(v: number | string | null | undefined): number {
  if (v == null) return 0;
  if (typeof v === "number") return v;
  const n = Number(v);
  return Number.isFinite(n) ? n : 0;
}

// Postgres percentile_cont returns null for empty groups; collapse a
// 7-row response down to the 4 numbers + 7-bucket bar series we need.
function aggregate(rows: SlaRow[]): Aggregate {
  const counts: number[] = new Array<number>(DAYS).fill(0);
  let totalReplies = 0;
  let under60 = 0;
  let medianWeightedSum = 0;
  let p95Max = 0;

  // Place each day-row in its slot relative to today (oldest at 0).
  const dayMs = 24 * 60 * 60 * 1000;
  const todayStart = new Date();
  todayStart.setHours(0, 0, 0, 0);
  const oldestStart = todayStart.getTime() - (DAYS - 1) * dayMs;

  for (const row of rows) {
    const conv = toNumber(row.conv_count);
    const u60 = toNumber(row.under_60s);
    const median = row.median_sec == null ? null : toNumber(row.median_sec);
    const p95 = row.p95_sec == null ? null : toNumber(row.p95_sec);

    totalReplies += conv;
    under60 += u60;
    if (median != null) medianWeightedSum += median * conv;
    if (p95 != null && p95 > p95Max) p95Max = p95;

    const bucketTime = new Date(row.day_bucket).getTime();
    const idx = Math.round((bucketTime - oldestStart) / dayMs);
    if (idx >= 0 && idx < DAYS) counts[idx] += conv;
  }

  const medianSec = totalReplies > 0 ? medianWeightedSum / totalReplies : null;
  const p95Sec = totalReplies > 0 ? p95Max : null;

  return {
    totalReplies,
    under60,
    medianSec,
    p95Sec,
    dailyCounts: counts,
    hasData: totalReplies > 0,
  };
}

function formatSeconds(s: number | null): string {
  if (s == null) return "—";
  if (s < 60) return `${Math.round(s)}s`;
  if (s < 3600) return `${(s / 60).toFixed(1)}m`;
  return `${(s / 3600).toFixed(1)}h`;
}

function formatPercent(num: number, denom: number): string {
  if (denom === 0) return "—";
  return `${Math.round((num / denom) * 100)}%`;
}

export async function SlaTile({ dealerId }: { dealerId: string }) {
  const sb = await createServerSupabase();
  const { data, error } = await sb.rpc("dashboard_sla_stats", { dealer_id: dealerId });
  if (error) {
    log.warn("sla_tile.rpc_error", { detail: error.message });
  }
  const rows = (data ?? []) as SlaRow[];
  const stats = aggregate(rows);

  if (!stats.hasData) {
    return (
      <section className="rounded-2xl border border-zinc-200 bg-white p-5">
        <header className="flex items-baseline justify-between">
          <h2 className="text-sm font-semibold tracking-tight text-zinc-900">Reply SLA · last 7 days</h2>
          <p className="text-xs text-zinc-500">No buyer activity yet</p>
        </header>
        <p className="mt-3 text-sm text-zinc-600">
          Stats appear here as soon as the AI starts answering buyers.
        </p>
      </section>
    );
  }

  return (
    <section className="rounded-2xl border border-zinc-200 bg-white p-5">
      <header className="flex items-baseline justify-between">
        <h2 className="text-sm font-semibold tracking-tight text-zinc-900">Reply SLA · last 7 days</h2>
        <p className="text-xs text-zinc-500">{stats.totalReplies} reply{stats.totalReplies === 1 ? "" : "ies"} answered</p>
      </header>

      <div className="mt-4 grid grid-cols-2 gap-3 sm:grid-cols-4">
        <Stat label="Median" value={formatSeconds(stats.medianSec)} />
        <Stat label="p95" value={formatSeconds(stats.p95Sec)} />
        <Stat label="Under 60s" value={formatPercent(stats.under60, stats.totalReplies)} />
        <Stat label="Leads saved" value={String(stats.under60)} hint="buyers who got a sub-minute reply" />
      </div>

      <div className="mt-4">
        <Sparkline values={stats.dailyCounts} />
      </div>
    </section>
  );
}

function Stat({ label, value, hint }: { label: string; value: string; hint?: string }) {
  return (
    <div className="rounded-xl border border-zinc-200 bg-zinc-50 p-3">
      <p className="text-[10px] font-semibold uppercase tracking-wider text-zinc-500">{label}</p>
      <p className="mt-1 text-lg font-semibold text-zinc-900">{value}</p>
      {hint ? <p className="mt-0.5 text-[11px] text-zinc-500">{hint}</p> : null}
    </div>
  );
}

// 7 stacked bars, max-height 40px. Pure SVG so it ships zero KB of JS.
// `values` is oldest → newest, length 7.
function Sparkline({ values }: { values: number[] }) {
  const max = Math.max(1, ...values);
  const barWidth = 14;
  const gap = 6;
  const height = 40;
  const totalWidth = values.length * barWidth + (values.length - 1) * gap;
  return (
    <div className="flex items-end gap-2">
      <svg
        viewBox={`0 0 ${totalWidth} ${height}`}
        width={totalWidth}
        height={height}
        role="img"
        aria-label={`Replies per day for the last ${values.length} days`}
        className="overflow-visible"
      >
        {values.map((v, i) => {
          const h = Math.max(2, Math.round((v / max) * height));
          const x = i * (barWidth + gap);
          const y = height - h;
          return (
            <rect
              key={i}
              x={x}
              y={y}
              width={barWidth}
              height={h}
              rx={2}
              className={v > 0 ? "fill-amber-400" : "fill-zinc-200"}
            >
              <title>{`${v} reply${v === 1 ? "" : "ies"}`}</title>
            </rect>
          );
        })}
      </svg>
      <span className="text-[10px] uppercase tracking-wider text-zinc-400">replies/day</span>
    </div>
  );
}
