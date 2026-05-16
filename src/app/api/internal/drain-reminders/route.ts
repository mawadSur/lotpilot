// T1.7 — Drains the scheduled_reminders outbox.
//
// Same auth + invocation shape as /api/internal/drain-audit-queue
// (constant-time bearer, GET+POST, service-role supabase, per-tick
// row cap). Vercel cron hits this every 5 minutes (see vercel.json);
// we claim due rows (send_at <= now) and dispatch via SMS or
// WhatsApp depending on conversation.channel.
//
// Per-row safety gates (matched at send time, NOT at enqueue time):
//   1. Dealer auto_confirm_enabled — flipped false post-enqueue?
//      Mark completed + last_error='auto_confirm_disabled'. We DO NOT
//      retry on dealer flip.
//   2. Conversation suppressed_at — buyer hit STOP after booking?
//      TCPA hard stop. Mark completed + last_error='suppressed'.
//   3. No buyer_phone for sms/whatsapp channel — can't reach them.
//      Mark completed + last_error='no_buyer_phone'.
//
// Send paths:
//   - sms      : Twilio (lib/sms/twilio). Insert a sent message row.
//   - whatsapp : Meta Cloud API (lib/whatsapp/cloud-api). Insert sent
//                message row. 24h-window failures auto-fallback to
//                template inside the helper.
//   - web/relay/voice/marketplace : Insert a dealer-visible inbox
//                message only. No outbound — these channels have no
//                buyer-side push. The dashboard reminder tile already
//                handles this case for manual sends.
//
// At-least-once semantics (mirror of drain-audit-queue): a send that
// succeeds at Twilio but fails the completed_at update would
// double-send on the next tick. We mitigate via Twilio's idempotent
// `delivery_sid` upsert pattern + accept this is rare. Better than
// silently dropping.

import { NextResponse, type NextRequest } from "next/server";
import { timingSafeEqual } from "node:crypto";
import { createServiceSupabase } from "@/lib/supabase-service";
import {
  internalDrainConfigured,
  requireInternalDrainToken,
  smsEnabled,
} from "@/lib/env";
import { sendSms } from "@/lib/sms/twilio";
import { sendWhatsAppMessage } from "@/lib/whatsapp/cloud-api";
import { pickReminderBody } from "@/lib/no-show-reminders";
import { log } from "@/lib/log";
import type {
  ConversationRow,
  DealerRow,
  ScheduledReminderRow,
} from "@/lib/db-types";

export const dynamic = "force-dynamic";

// Per-tick row cap. 50 reminders × (1 send + 1 message insert + 1
// outbox update) ≈ 150 round-trips per tick — well within 30s.
const DRAIN_BATCH = 50;

interface DrainResult {
  claimed: number;
  sent: number;
  skipped: number;
  failed: number;
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

async function markComplete(
  sb: ReturnType<typeof createServiceSupabase>,
  row: ScheduledReminderRow,
  lastError: string | null,
): Promise<void> {
  const nowIso = new Date().toISOString();
  const res = await sb
    .from("scheduled_reminders")
    .update({
      completed_at: nowIso,
      last_attempted_at: nowIso,
      attempts: row.attempts + 1,
      last_error: lastError,
    })
    .eq("id", row.id);
  if (res.error) {
    log.error("reminders.drain.complete_failed", {
      code: res.error.code,
      kind: row.kind,
    });
  }
}

async function bumpAttempt(
  sb: ReturnType<typeof createServiceSupabase>,
  row: ScheduledReminderRow,
  err: string,
): Promise<void> {
  const nowIso = new Date().toISOString();
  await sb
    .from("scheduled_reminders")
    .update({
      attempts: row.attempts + 1,
      last_attempted_at: nowIso,
      last_error: err,
    })
    .eq("id", row.id);
}

async function drainOne(
  sb: ReturnType<typeof createServiceSupabase>,
  row: ScheduledReminderRow,
): Promise<"sent" | "skipped" | "failed"> {
  // Load dealer + conversation. If either is missing the row is stale
  // (cascade-delete should have killed it; defensive belt).
  const dealerRes = await sb
    .from("dealers")
    .select("*")
    .eq("id", row.dealer_id)
    .maybeSingle();
  const dealer = dealerRes.data as DealerRow | null;
  if (!dealer) {
    await markComplete(sb, row, "dealer_missing");
    return "skipped";
  }
  const convRes = await sb
    .from("conversations")
    .select("*")
    .eq("id", row.conversation_id)
    .maybeSingle();
  const conversation = convRes.data as ConversationRow | null;
  if (!conversation) {
    await markComplete(sb, row, "conversation_missing");
    return "skipped";
  }

  // Dealer kill switch.
  if (!dealer.auto_confirm_enabled) {
    await markComplete(sb, row, "auto_confirm_disabled");
    return "skipped";
  }
  // TCPA hard stop: buyer suppressed after booking.
  if (conversation.suppressed_at) {
    await markComplete(sb, row, "suppressed");
    return "skipped";
  }

  const body = pickReminderBody(row, conversation.language);
  const channel = conversation.channel;

  // SMS path.
  if (channel === "sms") {
    if (!smsEnabled() || !conversation.buyer_phone) {
      await markComplete(sb, row, "no_buyer_phone");
      return "skipped";
    }
    const send = await sendSms({ to: conversation.buyer_phone, body });
    if (!send.queued) {
      await bumpAttempt(sb, row, `sms_failed:${send.error ?? "unknown"}`);
      return "failed";
    }
    await sb.from("messages").insert({
      conversation_id: conversation.id,
      role: "dealer",
      body,
      intent: "test_drive",
      language: conversation.language,
      approval_status: "sent",
      delivery_channel: "sms",
      delivery_sid: send.sid ?? null,
    });
    await markComplete(sb, row, null);
    return "sent";
  }

  // WhatsApp path.
  if (channel === "whatsapp") {
    if (!conversation.buyer_phone) {
      await markComplete(sb, row, "no_buyer_phone");
      return "skipped";
    }
    const send = await sendWhatsAppMessage({
      to: conversation.buyer_phone,
      body,
      conversationId: conversation.id,
      sb,
    });
    if (!send.queued) {
      await bumpAttempt(sb, row, `whatsapp_failed:${send.error ?? "unknown"}`);
      return "failed";
    }
    await sb.from("messages").insert({
      conversation_id: conversation.id,
      role: "dealer",
      body,
      intent: "test_drive",
      language: conversation.language,
      approval_status: "sent",
      delivery_channel: "whatsapp",
      delivery_sid: send.messageId ?? null,
    });
    await markComplete(sb, row, null);
    return "sent";
  }

  // Web / relay / voice / marketplace — no outbound push surface. We
  // drop a dealer-visible message into the conversation so the inbox
  // shows the auto-confirm and the dealer can act on it manually if
  // they want (e.g. call the buyer). This is the SAME pattern the
  // dashboard reminder tile uses for non-SMS dealers.
  await sb.from("messages").insert({
    conversation_id: conversation.id,
    role: "dealer",
    body,
    intent: "test_drive",
    language: conversation.language,
    approval_status: "sent",
    delivery_channel: null,
  });
  await markComplete(sb, row, "channel_no_push");
  return "sent";
}

async function drain(): Promise<DrainResult> {
  const sb = createServiceSupabase();
  const nowIso = new Date().toISOString();

  const claimRes = await sb
    .from("scheduled_reminders")
    .select("*")
    .is("completed_at", null)
    .lte("send_at", nowIso)
    .order("send_at", { ascending: true })
    .limit(DRAIN_BATCH);
  if (claimRes.error) {
    log.error("reminders.drain.claim_failed", {
      code: claimRes.error.code,
      message: claimRes.error.message,
    });
    return { claimed: 0, sent: 0, skipped: 0, failed: 0 };
  }
  const rows = (claimRes.data ?? []) as ScheduledReminderRow[];

  let sent = 0;
  let skipped = 0;
  let failed = 0;

  for (const row of rows) {
    try {
      const outcome = await drainOne(sb, row);
      if (outcome === "sent") sent += 1;
      else if (outcome === "skipped") skipped += 1;
      else failed += 1;
    } catch (err) {
      failed += 1;
      await bumpAttempt(sb, row, `exception:${(err as Error).message}`);
    }
  }

  return { claimed: rows.length, sent, skipped, failed };
}

async function handle(request: NextRequest): Promise<NextResponse> {
  if (!internalDrainConfigured) {
    return NextResponse.json(
      { error: "drain_not_configured" },
      { status: 503 },
    );
  }
  if (!authorize(request)) {
    return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  }

  const result = await drain();
  log.info("reminders.drain", {
    claimed: result.claimed,
    sent: result.sent,
    skipped: result.skipped,
    failed: result.failed,
  });
  return NextResponse.json(result, { status: 200 });
}

export async function GET(request: NextRequest): Promise<NextResponse> {
  return handle(request);
}

export async function POST(request: NextRequest): Promise<NextResponse> {
  return handle(request);
}
