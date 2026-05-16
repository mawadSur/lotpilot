// Post-test-drive sweep (T1.9). One responsibility per call:
//   - sweepCompletedTestDrives: find conversations whose scheduled_at
//     is in the past AND test_drive_status is null AND lead_status is
//     'booked'. Stamp test_drive_status='completed' and enqueue the
//     +24h/+72h/+168h follow-ups.
//   - drainDueFollowUps: claim up to N rows whose send_at <= now
//     and dispatch them one at a time via dispatcher.dispatchOne.
//
// Called from the /api/internal/drain-follow-ups Vercel cron handler.

import type { SupabaseClient } from "@supabase/supabase-js";
import type { FollowUpJobRow } from "../db-types";
import { log } from "../log";
import { dispatchOne } from "./dispatcher";
import { enqueueFollowUps, markTestDriveCompleted } from "./scheduler";

const SWEEP_BATCH = 200;
const DRAIN_BATCH = 50;

export interface SweepResult {
  swept: number;
  enqueued_steps: number;
}

interface ConvCandidate {
  id: string;
  dealer_id: string;
  scheduled_at: string;
}

export async function sweepCompletedTestDrives(
  sb: SupabaseClient,
): Promise<SweepResult> {
  const nowIso = new Date().toISOString();

  // Find booked conversations whose scheduled_at is in the past and
  // test_drive_status is still null. Service-role read — RLS not in
  // play. Cap at SWEEP_BATCH per tick.
  const res = await sb
    .from("conversations")
    .select("id,dealer_id,scheduled_at")
    .eq("lead_status", "booked")
    .is("test_drive_status", null)
    .not("scheduled_at", "is", null)
    .lt("scheduled_at", nowIso)
    .order("scheduled_at", { ascending: true })
    .limit(SWEEP_BATCH);

  if (res.error) {
    log.error("follow_up.sweep.query_failed", {
      code: res.error.code,
      detail: res.error.message,
    });
    return { swept: 0, enqueued_steps: 0 };
  }

  const rows = (res.data ?? []) as ConvCandidate[];
  let enqueuedSteps = 0;
  for (const row of rows) {
    await markTestDriveCompleted(sb, row.id);
    const enqRes = await enqueueFollowUps({
      sb,
      dealerId: row.dealer_id,
      conversationId: row.id,
      driveCompletedAt: new Date(row.scheduled_at),
    });
    enqueuedSteps += enqRes.inserted.length;
  }

  log.info("follow_up.sweep.complete", {
    swept: rows.length,
    enqueued_steps: enqueuedSteps,
  });
  return { swept: rows.length, enqueued_steps: enqueuedSteps };
}

export interface DrainResult {
  claimed: number;
  sent: number;
  cancelled: number;
  failed: number;
  skipped: number;
}

export async function drainDueFollowUps(
  sb: SupabaseClient,
): Promise<DrainResult> {
  const nowIso = new Date().toISOString();
  const res = await sb
    .from("follow_up_jobs")
    .select("*")
    .is("sent_at", null)
    .is("cancelled_at", null)
    .lte("send_at", nowIso)
    .order("send_at", { ascending: true })
    .limit(DRAIN_BATCH);

  if (res.error) {
    log.error("follow_up.drain.claim_failed", {
      code: res.error.code,
      detail: res.error.message,
    });
    return { claimed: 0, sent: 0, cancelled: 0, failed: 0, skipped: 0 };
  }

  const jobs = (res.data ?? []) as FollowUpJobRow[];
  let sent = 0;
  let cancelled = 0;
  let failed = 0;
  let skipped = 0;
  for (const job of jobs) {
    const outcome = await dispatchOne({ sb, job });
    switch (outcome.kind) {
      case "sent":      sent += 1; break;
      case "cancelled": cancelled += 1; break;
      case "skipped":   skipped += 1; break;
      case "failed":    failed += 1; break;
    }
  }

  log.info("follow_up.drain.complete", {
    claimed: jobs.length,
    sent,
    cancelled,
    failed,
    skipped,
  });
  return { claimed: jobs.length, sent, cancelled, failed, skipped };
}
