// T1.7-B — Auto-confirm reminder enqueuer. Called from the calendly
// webhook AFTER `lead_status='booked'` flips. We compute the no-show
// risk, then insert 1-2 rows into public.scheduled_reminders:
//
//   - confirm_24h : always enqueued (low/medium/high). Sent ~24h before
//     the appointment with friendly EN/ES copy.
//   - confirm_2h  : ONLY enqueued for medium/high risk tier. Sent ~2h
//     before with a tighter "see you soon" nudge.
//
// Reuses two pieces of existing infra:
//   - The Vercel cron pattern (vercel.json) + /api/internal/drain-*
//     drainer endpoints (see /api/internal/drain-audit-queue/route.ts:1)
//     — we add ONE new drainer rather than building a new scheduler.
//   - The reminderText() bilingual confirmation copy used by the
//     dashboard reminder tile
//     (/api/dashboard/conversations/[id]/reminder/route.ts:27).
//
// Both messages are pre-rendered to body_en / body_es at enqueue time
// and stored in the outbox row, so a later AI provider rotation
// doesn't retroactively change historical reminder copy. (The prompt
// allowed an AI-generated 24h message; in v0.7.2 we ship deterministic
// founder-tuned templates and document an AI variant as a follow-up
// — runtime Claude calls on the cron path would inflate cost on a
// feature that's "say hi politely 24h before the appointment".)
//
// TCPA: per the existing pipeline contract, STOP keyword suppression
// is enforced at SEND time by the drainer reading conversation.suppressed_at
// — NOT at enqueue time (a buyer can STOP after booking; we still
// don't send). The detectKeyword/STOP path lives in chat-pipeline.ts
// and we DO NOT bypass it here.

import type { SupabaseClient } from "@supabase/supabase-js";
import { scoreNoShowFromRow } from "./no-show";
import { log } from "./log";
import type {
  ConversationRow,
  DealerRow,
  Lang,
  MessageRow,
  ScheduledReminderKind,
} from "./db-types";

// Send-time offsets relative to scheduled_at. 24h and 2h are the
// product-spec values — keeping them as named constants makes
// regression debugging quick when a dealer asks "why did this fire
// at 5am".
const MS_HOUR = 60 * 60 * 1000;
const OFFSET_24H_MS = 24 * MS_HOUR;
const OFFSET_2H_MS = 2 * MS_HOUR;

// We DO NOT enqueue a reminder whose send_at would already be in the
// past (or within this grace window). Common case: dealer books a
// same-day test drive 3h out — the "24h before" reminder would be
// 21h in the past and meaningless. The 2h-before still fires.
const SEND_AT_GRACE_MS = 5 * 60 * 1000;

function buildConfirm24h(dealerName: string): { en: string; es: string } {
  return {
    en: `Hi — confirming your test drive at ${dealerName} tomorrow. Reply YES to confirm or text us to reschedule.`,
    es: `Hola — confirmamos tu prueba de manejo en ${dealerName} mañana. Responde SI para confirmar o escríbenos para reprogramar.`,
  };
}

function buildConfirm2h(dealerName: string): { en: string; es: string } {
  return {
    en: `Heads up — your test drive at ${dealerName} is in about 2 hours. See you soon! Text us if anything's changed.`,
    es: `Recordatorio — tu prueba de manejo en ${dealerName} es en unas 2 horas. ¡Nos vemos pronto! Avísanos si algo cambió.`,
  };
}

// Render the language-picked body. Used by the drainer at send time.
export function pickReminderBody(
  row: { body_en: string; body_es: string },
  language: Lang,
): string {
  return language === "es" ? row.body_es : row.body_en;
}

export interface EnqueueArgs {
  sb: SupabaseClient;
  dealer: DealerRow;
  conversation: ConversationRow;
  // Real Calendly-confirmed scheduled time. We trust the caller — the
  // calendly webhook just wrote it.
  scheduledAt: string;
  // Optional recent messages for the reply-latency factor in scoring.
  // Pass [] if you don't want to load them (the scoring math falls back
  // to neutral; the booking-gap factor still dominates).
  messages?: Pick<MessageRow, "role" | "created_at">[];
  requestId: string;
  // Override now() for tests.
  now?: string;
}

export interface EnqueueResult {
  enqueued: ScheduledReminderKind[];
  skipped: { kind: ScheduledReminderKind; reason: string }[];
}

export async function enqueueAutoConfirmReminders(
  args: EnqueueArgs,
): Promise<EnqueueResult> {
  const { sb, dealer, conversation, scheduledAt, requestId } = args;
  const result: EnqueueResult = { enqueued: [], skipped: [] };

  // Dealer-level kill switch. v0.7 default = true (migration 0013); a
  // dealer can flip false via a settings UI (follow-up). We honor it
  // synchronously at enqueue time AND the drainer re-checks at send
  // time — belt-and-braces.
  if (!dealer.auto_confirm_enabled) {
    log.info("auto_confirm.disabled_at_enqueue", {
      requestId,
      dealer_id: dealer.id,
      conversation_id: conversation.id,
    });
    result.skipped.push({ kind: "confirm_24h", reason: "dealer_disabled" });
    result.skipped.push({ kind: "confirm_2h", reason: "dealer_disabled" });
    return result;
  }

  // Suppressed (STOP) conversation. We DO NOT enqueue — the drainer
  // would skip these anyway, but skipping at enqueue keeps the audit
  // log clean and avoids cluttering the partial index.
  if (conversation.suppressed_at) {
    log.info("auto_confirm.suppressed_at_enqueue", {
      requestId,
      dealer_id: dealer.id,
      conversation_id: conversation.id,
    });
    result.skipped.push({ kind: "confirm_24h", reason: "suppressed" });
    result.skipped.push({ kind: "confirm_2h", reason: "suppressed" });
    return result;
  }

  const risk = scoreNoShowFromRow({
    conversation,
    dealer,
    scheduledAt,
    messages: args.messages ?? [],
    now: args.now,
  });

  const scheduledAtMs = new Date(scheduledAt).getTime();
  const nowMs = new Date(args.now ?? new Date().toISOString()).getTime();

  const body24 = buildConfirm24h(dealer.name);
  const body2 = buildConfirm2h(dealer.name);

  // 24h reminder — always.
  const sendAt24 = new Date(scheduledAtMs - OFFSET_24H_MS).toISOString();
  if (scheduledAtMs - OFFSET_24H_MS <= nowMs + SEND_AT_GRACE_MS) {
    result.skipped.push({ kind: "confirm_24h", reason: "past_or_grace" });
  } else {
    const ins24 = await sb.from("scheduled_reminders").insert({
      dealer_id: dealer.id,
      conversation_id: conversation.id,
      kind: "confirm_24h",
      risk_score: roundScore(risk.score),
      risk_tier: risk.tier,
      body_en: body24.en,
      body_es: body24.es,
      send_at: sendAt24,
      payload: {
        factors: risk.factors,
        scheduled_at: scheduledAt,
      },
    });
    if (ins24.error) {
      // Most likely cause: pending-unique-index conflict (Calendly
      // retry). Log + treat as "already enqueued" — no need to fail
      // the webhook.
      log.warn("auto_confirm.enqueue_24h_failed", {
        requestId,
        dealer_id: dealer.id,
        conversation_id: conversation.id,
        code: ins24.error.code,
      });
      result.skipped.push({ kind: "confirm_24h", reason: "insert_failed" });
    } else {
      result.enqueued.push("confirm_24h");
    }
  }

  // 2h reminder — medium/high tier only. Low-tier bookings skip this
  // by design (no need to nudge a hot lead who's clearly coming).
  if (risk.tier === "low") {
    result.skipped.push({ kind: "confirm_2h", reason: "tier_low" });
  } else {
    const sendAt2 = new Date(scheduledAtMs - OFFSET_2H_MS).toISOString();
    if (scheduledAtMs - OFFSET_2H_MS <= nowMs + SEND_AT_GRACE_MS) {
      result.skipped.push({ kind: "confirm_2h", reason: "past_or_grace" });
    } else {
      const ins2 = await sb.from("scheduled_reminders").insert({
        dealer_id: dealer.id,
        conversation_id: conversation.id,
        kind: "confirm_2h",
        risk_score: roundScore(risk.score),
        risk_tier: risk.tier,
        body_en: body2.en,
        body_es: body2.es,
        send_at: sendAt2,
        payload: {
          factors: risk.factors,
          scheduled_at: scheduledAt,
        },
      });
      if (ins2.error) {
        log.warn("auto_confirm.enqueue_2h_failed", {
          requestId,
          dealer_id: dealer.id,
          conversation_id: conversation.id,
          code: ins2.error.code,
        });
        result.skipped.push({ kind: "confirm_2h", reason: "insert_failed" });
      } else {
        result.enqueued.push("confirm_2h");
      }
    }
  }

  log.info("auto_confirm.enqueued", {
    requestId,
    dealer_id: dealer.id,
    conversation_id: conversation.id,
    enqueued: result.enqueued,
    skipped: result.skipped.map((s) => `${s.kind}:${s.reason}`),
    risk_tier: risk.tier,
  });

  return result;
}

// numeric(4,3) column → 3 decimals. Avoids INSERT 23514 check_violation
// on a long-tail JS float like 0.5450000000000001.
function roundScore(score: number): number {
  return Math.round(Math.min(Math.max(score, 0), 1) * 1000) / 1000;
}
