// Post-test-drive follow-up dispatcher (T1.9).
//
// Owns the "send one job" path:
//   1. Pre-send guards (the cancel checks the SCHEDULER didn't catch
//      because they happen between enqueue and drainer pickup):
//        - conversation.suppressed_at is set → cancel(no_consent)
//        - lead_status in (sold,lost)        → cancel(lead_*)
//        - any buyer message since the previous step's send_at        → cancel(buyer_replied)
//   2. Build a step-specific prompt seed + call Claude through the
//      existing buildSystemPrompt + callClaude pair so the founder
//      voice, inventory grounding, and bilingual auto-detect stay
//      consistent with the request-path chat pipeline.
//   3. Insert the AI message + dispatch via the existing chat-outbound
//      contract (SMS / WhatsApp / web is no-op on this path since the
//      buyer isn't on a live socket).
//   4. Stamp sent_at on the job. attempts++ + last_attempted_at every
//      time, so a retried tick after a transient AI 503 leaves a
//      breadcrumb trail.
//
// We do NOT extend chat-pipeline.ts — its surface is shaped for an
// inbound buyer turn, and bolt-ons would inflate the orchestrator past
// the 500-line cap.

import type { SupabaseClient } from "@supabase/supabase-js";
import {
  AI_MAX_OUTPUT_TOKENS,
  AiReplyError,
  buildSystemPrompt,
  callClaude,
  estimateMessagesChars,
  type SpanishPhraseExample,
} from "../ai";
import {
  assertBudgetAvailable,
  BudgetExceededError,
  estimateCallUsd,
  recordSpend,
} from "../budget";
import { dispatchOutbound } from "../chat-outbound";
import type {
  ConversationRow,
  DealerRow,
  FollowUpJobRow,
  FollowUpStep,
  MessageRow,
  VehicleRow,
} from "../db-types";
import { log } from "../log";
import { cancelFollowUps, FOLLOW_UP_OFFSETS_MS } from "./scheduler";

export interface DispatchOneArgs {
  sb: SupabaseClient;
  job: FollowUpJobRow;
}

export type DispatchOutcome =
  | { kind: "sent"; messageId: string }
  | { kind: "cancelled"; reason: string }
  | { kind: "skipped"; reason: string }
  | { kind: "failed"; detail: string };

// Pre-fetched context for one job. Public so unit tests can pass a
// fixture instead of round-tripping through Supabase.
export interface JobContext {
  dealer: DealerRow;
  conversation: ConversationRow;
  vehicles: VehicleRow[];
  history: Pick<MessageRow, "role" | "body" | "created_at">[];
}

// Step-specific seed line. Inserted as a synthetic buyer message so
// the system prompt's normal "answer the buyer" rule still applies —
// Claude reads it as if the buyer asked us this. We append a
// `[FOLLOW_UP step=N]` tag so the founder voice + intent classification
// still work but the model knows this is an outbound nudge, not a
// reply.
function seedLine(step: FollowUpStep, dealerName: string): string {
  if (step === 1) {
    return (
      `[FOLLOW_UP step=1 +24h after test drive] Write a short, warm ` +
      `message asking how the test drive went. Open-ended question, no ` +
      `pressure. Sign off as ${dealerName}. Reply only with the message.`
    );
  }
  if (step === 2) {
    return (
      `[FOLLOW_UP step=2 +72h after test drive] Buyer hasn't replied to ` +
      `our first nudge. Send a slightly warmer touch — mention you're ` +
      `still around if they have questions about the car. One question ` +
      `max, no pressure. Sign off as ${dealerName}. Reply only with the message.`
    );
  }
  return (
    `[FOLLOW_UP step=3 +7d after test drive] Final nudge. Acknowledge it ` +
    `has been a week, leave the door open, and close out. Two sentences ` +
    `max. Sign off as ${dealerName}. Reply only with the message.`
  );
}

// Has the buyer sent ANY message after the previous step's send_at?
// step=1 has no previous step — we still skip when the buyer has
// replied AFTER the test drive ended (driveCompletedAt = send_at - 24h).
async function buyerRepliedSincePrev(
  sb: SupabaseClient,
  job: FollowUpJobRow,
): Promise<boolean> {
  // The anchor we care about for "fresh reply" is the previous
  // outbound send. For step 1 there's no prior follow-up, so we
  // anchor to driveCompletedAt = send_at - 24h.
  let anchorIso: string;
  if (job.step === 1) {
    anchorIso = new Date(
      new Date(job.send_at).getTime() - FOLLOW_UP_OFFSETS_MS[1],
    ).toISOString();
  } else {
    const prevStep = (job.step - 1) as FollowUpStep;
    const prev = await sb
      .from("follow_up_jobs")
      .select("send_at,sent_at")
      .eq("conversation_id", job.conversation_id)
      .eq("step", prevStep)
      .maybeSingle();
    const prevRow = prev.data as { send_at: string; sent_at: string | null } | null;
    anchorIso = prevRow?.sent_at ?? prevRow?.send_at ?? job.created_at;
  }

  const res = await sb
    .from("messages")
    .select("id", { count: "exact", head: true })
    .eq("conversation_id", job.conversation_id)
    .eq("role", "buyer")
    .gt("created_at", anchorIso);
  return (res.count ?? 0) > 0;
}

// Load every row the AI call needs in one round-trip per kind.
async function loadJobContext(
  sb: SupabaseClient,
  job: FollowUpJobRow,
): Promise<JobContext | null> {
  const dealerRes = await sb
    .from("dealers")
    .select("*")
    .eq("id", job.dealer_id)
    .maybeSingle();
  const dealer = dealerRes.data as DealerRow | null;
  if (!dealer) return null;

  const convRes = await sb
    .from("conversations")
    .select("*")
    .eq("id", job.conversation_id)
    .maybeSingle();
  const conversation = convRes.data as ConversationRow | null;
  if (!conversation) return null;

  const [historyRes, vehiclesRes] = await Promise.all([
    sb
      .from("messages")
      .select("role,body,created_at")
      .eq("conversation_id", job.conversation_id)
      .order("created_at", { ascending: true })
      .limit(20),
    sb
      .from("vehicles")
      .select("*")
      .eq("dealer_id", dealer.id)
      .eq("status", "available")
      .order("updated_at", { ascending: false })
      .limit(50),
  ]);

  const history = (historyRes.data ?? []) as Pick<
    MessageRow,
    "role" | "body" | "created_at"
  >[];
  const vehicles = (vehiclesRes.data ?? []) as VehicleRow[];
  return { dealer, conversation, vehicles, history };
}

export async function dispatchOne(args: DispatchOneArgs): Promise<DispatchOutcome> {
  const { sb, job } = args;
  const nowIso = new Date().toISOString();

  // Bump attempts FIRST so a crash mid-flight still leaves a breadcrumb.
  await sb
    .from("follow_up_jobs")
    .update({ attempts: job.attempts + 1, last_attempted_at: nowIso })
    .eq("id", job.id);

  const ctx = await loadJobContext(sb, job);
  if (!ctx) {
    return { kind: "failed", detail: "context_load_failed" };
  }
  const { dealer, conversation } = ctx;

  // Cancel-on-* checks. These mirror the live-cancel paths but are
  // also our final defence — a job that was queued before the buyer
  // replied + a cancel that raced with the drainer will both end up
  // here, and we cancel on the read.
  if (conversation.suppressed_at) {
    await cancelFollowUps({ sb, conversationId: conversation.id, reason: "opted_out" });
    return { kind: "cancelled", reason: "suppressed" };
  }
  if (conversation.lead_status === "sold") {
    await cancelFollowUps({ sb, conversationId: conversation.id, reason: "lead_sold" });
    return { kind: "cancelled", reason: "lead_sold" };
  }
  if (conversation.lead_status === "lost") {
    await cancelFollowUps({ sb, conversationId: conversation.id, reason: "lead_lost" });
    return { kind: "cancelled", reason: "lead_lost" };
  }
  if (await buyerRepliedSincePrev(sb, job)) {
    await cancelFollowUps({ sb, conversationId: conversation.id, reason: "buyer_replied" });
    return { kind: "cancelled", reason: "buyer_replied" };
  }

  // TCPA after-hours guard for SMS/WhatsApp (per channel).
  if (conversation.channel === "sms" || conversation.channel === "whatsapp") {
    if (!isWithinDealerHours(dealer)) {
      // Defer: bump send_at to the next business-hours open and leave
      // the job queued. We add ~1h slop so the next drainer tick after
      // open is the one that picks it up.
      const nextOpen = nextOpenWithin12h(dealer) ?? new Date(Date.now() + 60 * 60 * 1000);
      await sb
        .from("follow_up_jobs")
        .update({ send_at: nextOpen.toISOString() })
        .eq("id", job.id);
      return { kind: "skipped", reason: "after_hours_deferred" };
    }
  }

  // Run the AI through the same buildSystemPrompt + callClaude pair as
  // chat-pipeline.ts so the founder voice + bilingual auto-detect stay
  // consistent. We feed the conversation history then append a synthetic
  // buyer turn = the step's seed line; Claude generates a reply as if
  // answering it.
  const spanishExamples: SpanishPhraseExample[] = [];
  const seedText = seedLine(job.step, dealer.name);
  const wrappedSeed = `⁂BUYER_START⁂${seedText}⁂BUYER_END⁂`;

  const systemChars = buildSystemPrompt(dealer, ctx.vehicles, spanishExamples).length;
  const messagesChars = estimateMessagesChars(
    ctx.history.map((m) => ({ role: m.role, body: m.body })),
    wrappedSeed,
  );
  const estimatedUsd = estimateCallUsd(systemChars, messagesChars, AI_MAX_OUTPUT_TOKENS);
  try {
    await assertBudgetAvailable({ dealerId: dealer.id, estimatedUsd });
  } catch (err) {
    if (err instanceof BudgetExceededError) {
      log.warn("follow_up.budget_exhausted", {
        dealer_id: dealer.id,
        conversation_id: conversation.id,
        step: job.step,
      });
      return { kind: "failed", detail: "budget_exhausted" };
    }
    throw err;
  }

  let aiReply;
  try {
    aiReply = await callClaude({
      dealer,
      vehicles: ctx.vehicles,
      history: ctx.history.map((m) => ({ role: m.role, body: m.body })),
      buyerWrappedMessage: wrappedSeed,
      conversationLanguage: conversation.language,
      spanishExamples,
    });
  } catch (err) {
    const detail = err instanceof AiReplyError ? err.message : "ai_error";
    log.warn("follow_up.ai_error", {
      dealer_id: dealer.id,
      conversation_id: conversation.id,
      step: job.step,
      detail,
    });
    return { kind: "failed", detail };
  }

  // Persist + dispatch.
  const insertRes = await sb
    .from("messages")
    .insert({
      conversation_id: conversation.id,
      role: "ai",
      body: aiReply.reply,
      intent: aiReply.intent,
      language: aiReply.language,
      approval_status: "auto",
      delivery_channel: conversation.channel,
    })
    .select("id")
    .single();
  const inserted = insertRes.data as { id: string } | null;
  if (insertRes.error || !inserted) {
    log.error("follow_up.message_insert_failed", {
      dealer_id: dealer.id,
      conversation_id: conversation.id,
      step: job.step,
      code: insertRes.error?.code,
    });
    return { kind: "failed", detail: "message_insert_failed" };
  }

  await recordSpend({
    dealerId: dealer.id,
    inputTokens: aiReply.usage.input_tokens,
    outputTokens: aiReply.usage.output_tokens,
  });

  await dispatchOutbound({
    sb,
    channel: conversation.channel,
    dealer,
    conversationId: conversation.id,
    buyerPhone: conversation.buyer_phone,
    savedMessageId: inserted.id,
    finalReply: aiReply.reply,
    requestId: `follow-up-${job.id}`,
  });

  await sb
    .from("follow_up_jobs")
    .update({ sent_at: new Date().toISOString() })
    .eq("id", job.id);

  log.info("follow_up.sent", {
    dealer_id: dealer.id,
    conversation_id: conversation.id,
    step: job.step,
    language: aiReply.language,
  });

  return { kind: "sent", messageId: inserted.id };
}

// ----------------------------------------------------------------------
// Dealer-hours window. The dealer row already carries a business_hours
// map in dealer-local time; we evaluate "is now within today's hours"
// in the dealer's timezone. SMS / WhatsApp TCPA recommends 8am-9pm
// local — the dealer's own hours are tighter than that, so respecting
// them is strictly more conservative.

function isWithinDealerHours(dealer: DealerRow): boolean {
  return dealerLocalRange(dealer).inWindow;
}

interface LocalRange {
  inWindow: boolean;
  hhmm: string;
  todayKey: keyof DealerRow["business_hours"];
}

function dealerLocalRange(dealer: DealerRow): LocalRange {
  const tz = dealer.timezone || "America/New_York";
  const fmt = new Intl.DateTimeFormat("en-US", {
    timeZone: tz,
    weekday: "short",
    hour: "2-digit",
    minute: "2-digit",
    hour12: false,
  });
  const parts = fmt.formatToParts(new Date());
  const weekday = parts.find((p) => p.type === "weekday")?.value ?? "Mon";
  const hour = parts.find((p) => p.type === "hour")?.value ?? "00";
  const minute = parts.find((p) => p.type === "minute")?.value ?? "00";
  const hhmm = `${hour.padStart(2, "0")}:${minute.padStart(2, "0")}`;
  const key = weekdayToKey(weekday);
  const window = dealer.business_hours[key];
  if (!window) return { inWindow: false, hhmm, todayKey: key };
  return { inWindow: hhmm >= window[0] && hhmm <= window[1], hhmm, todayKey: key };
}

function weekdayToKey(weekday: string): keyof DealerRow["business_hours"] {
  switch (weekday.slice(0, 3).toLowerCase()) {
    case "mon": return "mon";
    case "tue": return "tue";
    case "wed": return "wed";
    case "thu": return "thu";
    case "fri": return "fri";
    case "sat": return "sat";
    default:    return "sun";
  }
}

// Best-effort "when does the dealer next open within the next 12h?"
// Coarse: we just step 30 minutes at a time and re-evaluate the
// in-window check. Within 24 ticks we either find the open or fall
// through and the caller defers by 1h. This avoids re-implementing
// timezone arithmetic for one cron path.
function nextOpenWithin12h(dealer: DealerRow): Date | null {
  let cursor = new Date(Date.now() + 30 * 60 * 1000);
  for (let i = 0; i < 24; i += 1) {
    if (isWithinDealerHoursAt(dealer, cursor)) return cursor;
    cursor = new Date(cursor.getTime() + 30 * 60 * 1000);
  }
  return null;
}

function isWithinDealerHoursAt(dealer: DealerRow, at: Date): boolean {
  const tz = dealer.timezone || "America/New_York";
  const fmt = new Intl.DateTimeFormat("en-US", {
    timeZone: tz, weekday: "short", hour: "2-digit", minute: "2-digit", hour12: false,
  });
  const parts = fmt.formatToParts(at);
  const weekday = parts.find((p) => p.type === "weekday")?.value ?? "Mon";
  const hour = parts.find((p) => p.type === "hour")?.value ?? "00";
  const minute = parts.find((p) => p.type === "minute")?.value ?? "00";
  const hhmm = `${hour.padStart(2, "0")}:${minute.padStart(2, "0")}`;
  const window = dealer.business_hours[weekdayToKey(weekday)];
  if (!window) return false;
  return hhmm >= window[0] && hhmm <= window[1];
}
