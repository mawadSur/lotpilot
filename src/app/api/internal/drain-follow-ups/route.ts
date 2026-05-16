// Drains the post-test-drive follow-up queue (T1.9).
//
// Each Vercel cron tick we:
//   1. sweepCompletedTestDrives — find conversations whose
//      scheduled_at is in the past, stamp test_drive_status='completed',
//      and enqueue +24h/+72h/+168h follow_up_jobs rows (idempotent via
//      the (conversation_id, step) UNIQUE constraint from migration 0014).
//   2. drainDueFollowUps — claim up to 50 rows whose send_at <= now,
//      generate an AI follow-up via buildSystemPrompt+callClaude, persist
//      + dispatch via the existing chat-outbound contract, then stamp
//      sent_at.
//
// Authentication mirrors /api/internal/drain-audit-queue — constant-time
// bearer-token check against INTERNAL_DRAIN_TOKEN. Vercel cron hits GET;
// we also accept POST for human curl probes.

import { NextResponse, type NextRequest } from "next/server";
import { timingSafeEqual } from "node:crypto";
import { createServiceSupabase } from "@/lib/supabase-service";
import {
  drainDueFollowUps,
  sweepCompletedTestDrives,
} from "@/lib/follow-up/sweep";
import {
  internalDrainConfigured,
  requireInternalDrainToken,
} from "@/lib/env";
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
  const sweep = await sweepCompletedTestDrives(sb);
  const drain = await drainDueFollowUps(sb);

  log.info("follow_up.cron.tick", {
    swept: sweep.swept,
    enqueued_steps: sweep.enqueued_steps,
    claimed: drain.claimed,
    sent: drain.sent,
    cancelled: drain.cancelled,
    failed: drain.failed,
    skipped: drain.skipped,
  });

  return NextResponse.json({ sweep, drain }, { status: 200 });
}

export async function GET(request: NextRequest): Promise<NextResponse> {
  return handle(request);
}

export async function POST(request: NextRequest): Promise<NextResponse> {
  return handle(request);
}
