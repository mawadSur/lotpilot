// T4.2 — Expire stale lead-shares.
//
// A lead-share row stays in 'consent_sent' until the buyer says YES
// or NO. Many buyers will simply not reply. After 48h we age the row
// to 'expired' so:
//   1. The source dealer's inbox stops saying "awaiting consent" for
//      shares the buyer has clearly abandoned.
//   2. The partial unique index
//      (lead_shares_one_open_per_source_idx) releases — the source
//      dealer can re-share if circumstances change.
//
// We deliberately do NOT message the buyer on expiry. CTIA is clear
// that an unsolicited "are you still there?" SMS is itself an opt-in
// breach.
//
// Idempotent: a re-run with no due rows returns expired=0.

import type { SupabaseClient } from "@supabase/supabase-js";
import { log } from "../log";
import type { LeadShareRow } from "../db-types";

export const EXPIRY_HOURS = 48;
export const SWEEP_BATCH = 200;

export interface ExpireResult {
  expired: number;
  failed: number;
  error: string | null;
}

export async function expireStaleLeadShares(
  sb: SupabaseClient,
): Promise<ExpireResult> {
  const cutoffIso = new Date(
    Date.now() - EXPIRY_HOURS * 60 * 60 * 1000,
  ).toISOString();

  const claimRes = await sb
    .from("lead_shares")
    .select("id,source_dealer_id,source_conversation_id,consent_sent_at")
    .eq("status", "consent_sent")
    .lte("consent_sent_at", cutoffIso)
    .order("consent_sent_at", { ascending: true })
    .limit(SWEEP_BATCH);
  if (claimRes.error) {
    return { expired: 0, failed: 0, error: claimRes.error.message };
  }
  const rows = (claimRes.data ?? []) as Pick<
    LeadShareRow,
    "id" | "source_dealer_id" | "source_conversation_id" | "consent_sent_at"
  >[];
  if (rows.length === 0) {
    return { expired: 0, failed: 0, error: null };
  }

  const nowIso = new Date().toISOString();
  // Single UPDATE: by id-list. We re-check status='consent_sent' in
  // the WHERE so a concurrent YES/NO from the chat-pipeline doesn't
  // get clobbered by the sweep.
  const updRes = await sb
    .from("lead_shares")
    .update({ status: "expired", expired_at: nowIso })
    .in("id", rows.map((r) => r.id))
    .eq("status", "consent_sent")
    .select("id");
  if (updRes.error) {
    log.error("lead_share.expire_update_failed", {
      attempted: rows.length,
      code: updRes.error.code,
    });
    return { expired: 0, failed: rows.length, error: updRes.error.message };
  }
  const expired = ((updRes.data ?? []) as { id: string }[]).length;
  const failed = rows.length - expired;
  if (expired > 0) {
    log.info("lead_share.expired", { expired, failed });
  }
  return { expired, failed, error: null };
}
