// Post-test-drive follow-up scheduler (T1.9).
//
// Two surfaces:
//   - enqueueFollowUps: writes the +24h / +72h / +168h rows for a
//     conversation whose test drive just completed. Idempotent via the
//     (conversation_id, step) unique constraint — a retried Calendly
//     `invitee.event_ended` callback won't double-enqueue.
//   - cancelFollowUps: flips cancelled_at on every open job for a
//     conversation. Called from the chat pipeline on buyer reply, from
//     the lead-status route on sold/lost, and from keyword handling
//     on STOP.
//
// We deliberately keep these pure-data: the AI generation + outbound
// delivery lives in ./dispatcher so the scheduler stays cheap to call
// from request-path code (chat-pipeline, calendly webhook).

import type { SupabaseClient } from "@supabase/supabase-js";
import type {
  FollowUpCancelReason,
  FollowUpStep,
} from "../db-types";
import { log } from "../log";

// Step → offset from test-drive completion. 24h / 72h / 168h (7d).
// Architect note: keep these as plain Numbers (not Duration objects) —
// migration 0014 stores send_at as timestamptz and we compute the
// delta in JS so the test harness can fast-forward by stubbing Date.
export const FOLLOW_UP_OFFSETS_MS: Record<FollowUpStep, number> = {
  1: 24 * 60 * 60 * 1000,
  2: 72 * 60 * 60 * 1000,
  3: 168 * 60 * 60 * 1000,
};

export interface EnqueueArgs {
  sb: SupabaseClient;
  dealerId: string;
  conversationId: string;
  // Anchor time = when the test drive completed. Steps are +24h / +72h /
  // +168h from this anchor.
  driveCompletedAt: Date;
}

export interface EnqueueResult {
  inserted: FollowUpStep[];
  skipped: FollowUpStep[];
}

// Idempotent enqueue. Returns which steps were actually written vs.
// pre-existing (conflict-on-unique). The (conversation_id, step) UNIQUE
// constraint from migration 0014 means a retried Calendly callback
// silently no-ops here.
export async function enqueueFollowUps(args: EnqueueArgs): Promise<EnqueueResult> {
  const steps: FollowUpStep[] = [1, 2, 3];
  const rows = steps.map((step) => ({
    dealer_id: args.dealerId,
    conversation_id: args.conversationId,
    step,
    send_at: new Date(
      args.driveCompletedAt.getTime() + FOLLOW_UP_OFFSETS_MS[step],
    ).toISOString(),
  }));

  // upsert with ignoreDuplicates: returns only the actually-inserted
  // rows; ConflictRows are silently dropped. PostgREST 11+ accepts
  // `onConflict` as a column list — we name our unique constraint's
  // columns explicitly so a future column rename surfaces here.
  const res = await args.sb
    .from("follow_up_jobs")
    .upsert(rows, {
      onConflict: "conversation_id,step",
      ignoreDuplicates: true,
    })
    .select("step");

  if (res.error) {
    log.error("follow_up.enqueue_failed", {
      dealer_id: args.dealerId,
      conversation_id: args.conversationId,
      code: res.error.code,
      detail: res.error.message,
    });
    return { inserted: [], skipped: steps };
  }

  const insertedSteps = ((res.data ?? []) as { step: number }[]).map(
    (r) => r.step as FollowUpStep,
  );
  const inserted: FollowUpStep[] = steps.filter((s) => insertedSteps.includes(s));
  const skipped: FollowUpStep[] = steps.filter((s) => !insertedSteps.includes(s));

  log.info("follow_up.enqueued", {
    dealer_id: args.dealerId,
    conversation_id: args.conversationId,
    inserted_count: inserted.length,
    skipped_count: skipped.length,
  });

  return { inserted, skipped };
}

export interface CancelArgs {
  sb: SupabaseClient;
  conversationId: string;
  reason: FollowUpCancelReason;
}

export interface CancelResult {
  cancelled: number;
}

// Cancel every still-open follow-up for this conversation. "Open" =
// sent_at IS NULL AND cancelled_at IS NULL. Safe to call repeatedly —
// already-cancelled rows are filtered out by the WHERE clause so we
// don't stomp the original cancel_reason. Already-sent rows are
// untouched.
export async function cancelFollowUps(args: CancelArgs): Promise<CancelResult> {
  const nowIso = new Date().toISOString();
  const res = await args.sb
    .from("follow_up_jobs")
    .update({ cancelled_at: nowIso, cancel_reason: args.reason })
    .eq("conversation_id", args.conversationId)
    .is("sent_at", null)
    .is("cancelled_at", null)
    .select("id");

  if (res.error) {
    log.warn("follow_up.cancel_failed", {
      conversation_id: args.conversationId,
      reason: args.reason,
      code: res.error.code,
    });
    return { cancelled: 0 };
  }
  const cancelled = (res.data ?? []).length;
  if (cancelled > 0) {
    log.info("follow_up.cancelled", {
      conversation_id: args.conversationId,
      reason: args.reason,
      cancelled,
    });
  }
  return { cancelled };
}

// Stamp test_drive_status='completed' on a conversation that just
// finished its test drive. Idempotent — re-stamps the same value.
// Caller is responsible for then calling enqueueFollowUps.
export async function markTestDriveCompleted(
  sb: SupabaseClient,
  conversationId: string,
): Promise<void> {
  const res = await sb
    .from("conversations")
    .update({ test_drive_status: "completed" })
    .eq("id", conversationId);
  if (res.error) {
    log.warn("follow_up.mark_completed_failed", {
      conversation_id: conversationId,
      code: res.error.code,
    });
  }
}
