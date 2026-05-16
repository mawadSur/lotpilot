// T2.5 Re-engagement sweep cron.
//
// Vercel cron hits this daily at 10:00 UTC (see vercel.json). The
// authentication / shape mirrors /api/internal/drain-audit-queue:
//   - constant-time bearer-token auth against INTERNAL_DRAIN_TOKEN
//   - GET and POST both accepted (cron uses GET; operator may curl POST)
//   - service-role Supabase client (no dealer auth context)
//   - returns a compact JSON summary; no PII leaks into logs / response.
//
// Flow:
//   1. Load all vehicle_events created in the last 24h. We do NOT
//      mark events as processed — the matcher + send.ts gates (esp.
//      the 14-day cooldown) make a second pass over the same event
//      idempotent.
//   2. For each event: matcher returns ≤5 candidates; we attempt
//      each via send.ts. TCPA gates inside send.ts decide whether
//      anything actually leaves.
//   3. Tally outcomes and return.
//
// Why daily rather than every 5 minutes (like the drain): re-engagement
// is intentionally low-cadence. A buyer who saw a Civic match today
// shouldn't get another nudge tomorrow because the Civic price
// dropped $200 — and even if they did pass the 14-day cooldown, we'd
// rather batch the comparison once a day than spray during peak hours.

import { NextResponse, type NextRequest } from "next/server";
import { timingSafeEqual } from "node:crypto";
import { createServiceSupabase } from "@/lib/supabase-service";
import {
  internalDrainConfigured,
  requireInternalDrainToken,
} from "@/lib/env";
import { log } from "@/lib/log";
import { findCandidatesForVehicleEvent } from "@/lib/re-engagement/match";
import { attemptReEngagement } from "@/lib/re-engagement/send";
import type { DealerRow, VehicleEventRow } from "@/lib/db-types";

export const dynamic = "force-dynamic";

const SWEEP_WINDOW_MS = 24 * 60 * 60 * 1000;
// Bound the number of events processed per tick so a backlog spike
// doesn't blow lambda runtime. 200 events × 5 candidates × ~6 DB
// round-trips of gates ≈ 6000 round-trips — well within the 30s
// budget on a hot connection pool.
const MAX_EVENTS_PER_SWEEP = 200;

interface SweepResult {
  events: number;
  candidates: number;
  sent: number;
  skipped: number;
  skipBreakdown: Record<string, number>;
}

function authorize(request: NextRequest): boolean {
  const header = request.headers.get("authorization") ?? "";
  const prefix = "Bearer ";
  if (!header.startsWith(prefix)) return false;
  const actual = header.slice(prefix.length);
  const expected = requireInternalDrainToken();
  if (actual.length !== expected.length) return false;
  try {
    return timingSafeEqual(Buffer.from(actual), Buffer.from(expected));
  } catch {
    return false;
  }
}

async function sweep(): Promise<SweepResult> {
  const sb = createServiceSupabase();
  const now = new Date();
  const sinceIso = new Date(now.getTime() - SWEEP_WINDOW_MS).toISOString();

  // 1. Pull recent vehicle_events.
  const eventsRes = await sb
    .from("vehicle_events")
    .select("*")
    .gt("created_at", sinceIso)
    .order("created_at", { ascending: false })
    .limit(MAX_EVENTS_PER_SWEEP);
  if (eventsRes.error) {
    log.error("reengagement.sweep.events_query_failed", {
      code: eventsRes.error.code,
    });
    return {
      events: 0,
      candidates: 0,
      sent: 0,
      skipped: 0,
      skipBreakdown: {},
    };
  }
  const events = (eventsRes.data ?? []) as VehicleEventRow[];

  // Dealer cache: many events will belong to the same dealer; we lift
  // the SELECT * out so each event doesn't refetch.
  const dealerCache = new Map<string, DealerRow>();
  async function loadDealer(id: string): Promise<DealerRow | null> {
    const cached = dealerCache.get(id);
    if (cached) return cached;
    const res = await sb.from("dealers").select("*").eq("id", id).maybeSingle();
    if (res.error || !res.data) return null;
    const dealer = res.data as DealerRow;
    dealerCache.set(id, dealer);
    return dealer;
  }

  const skipBreakdown: Record<string, number> = {};
  let candidateCount = 0;
  let sent = 0;
  let skipped = 0;

  for (const event of events) {
    const dealer = await loadDealer(event.dealer_id);
    if (!dealer) continue;
    const candidates = await findCandidatesForVehicleEvent(sb, event);
    candidateCount += candidates.length;
    for (const candidate of candidates) {
      const outcome = await attemptReEngagement({ sb, dealer, now }, candidate);
      if (outcome.sent) {
        sent += 1;
      } else {
        skipped += 1;
        const key = outcome.skipReason ?? "unknown";
        skipBreakdown[key] = (skipBreakdown[key] ?? 0) + 1;
      }
    }
  }

  return {
    events: events.length,
    candidates: candidateCount,
    sent,
    skipped,
    skipBreakdown,
  };
}

async function handle(request: NextRequest): Promise<NextResponse> {
  if (!internalDrainConfigured) {
    return NextResponse.json(
      { error: "sweep_not_configured" },
      { status: 503 },
    );
  }
  if (!authorize(request)) {
    return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  }

  const result = await sweep();
  log.info("reengagement.sweep", {
    events: result.events,
    candidates: result.candidates,
    sent: result.sent,
    skipped: result.skipped,
  });
  return NextResponse.json(result, { status: 200 });
}

export async function GET(request: NextRequest): Promise<NextResponse> {
  return handle(request);
}

export async function POST(request: NextRequest): Promise<NextResponse> {
  return handle(request);
}
