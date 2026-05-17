// T4.2 — Cron drainer that ages stale consent_sent lead-shares to
// 'expired' after EXPIRY_HOURS (48h).
//
// Same auth + invocation shape as the other /api/internal/drain-*
// routes (constant-time bearer, GET+POST, service-role supabase,
// per-tick row cap).

import { NextResponse, type NextRequest } from "next/server";
import { timingSafeEqual } from "node:crypto";
import { createServiceSupabase } from "@/lib/supabase-service";
import {
  internalDrainConfigured,
  requireInternalDrainToken,
} from "@/lib/env";
import { expireStaleLeadShares } from "@/lib/lead-share/expire";
import { log } from "@/lib/log";

export const dynamic = "force-dynamic";

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

async function handle(request: NextRequest): Promise<NextResponse> {
  if (!internalDrainConfigured) {
    return NextResponse.json({ error: "drain_not_configured" }, { status: 503 });
  }
  if (!authorize(request)) {
    return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  }

  const sb = createServiceSupabase();
  const result = await expireStaleLeadShares(sb);
  log.info("lead_share.cron.tick", {
    expired: result.expired,
    failed: result.failed,
    error: result.error,
  });
  return NextResponse.json(result, { status: 200 });
}

export async function GET(request: NextRequest): Promise<NextResponse> {
  return handle(request);
}

export async function POST(request: NextRequest): Promise<NextResponse> {
  return handle(request);
}
