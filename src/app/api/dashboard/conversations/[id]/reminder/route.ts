// In-app test-drive reminder. Two delivery modes:
//   - SMS:   POST {channel: "sms"}    — sends via Twilio + records as
//            outgoing dealer message; requires dealer.sms_number AND
//            conversation.buyer_phone AND SMS_ENABLED.
//   - copy:  POST {channel: "copy"}   — server returns the canned text
//            for the client to clipboard-write; no DB write.

import { NextResponse, type NextRequest } from "next/server";
import { revalidatePath } from "next/cache";
import { requireDealer } from "@/lib/auth";
import { createServerSupabase } from "@/lib/supabase-server";
import { sendSms } from "@/lib/sms/twilio";
import { smsEnabled } from "@/lib/env";
import { log } from "@/lib/log";
import type { ConversationRow, Lang } from "@/lib/db-types";

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

interface PageContext {
  params: Promise<{ id: string }>;
}

interface ReminderBody {
  channel?: unknown;
}

export function reminderText(dealerName: string, language: Lang): string {
  return language === "es"
    ? `Hola — confirmamos tu prueba de manejo en ${dealerName} mañana. Responde SI para confirmar o escríbenos para reprogramar.`
    : `Hi — confirming your test drive at ${dealerName} tomorrow. Reply YES to confirm or text us to reschedule.`;
}

export async function POST(request: NextRequest, ctx: PageContext) {
  const { id } = await ctx.params;
  if (!UUID_RE.test(id)) {
    return NextResponse.json({ error: "Invalid id." }, { status: 400 });
  }

  let body: ReminderBody;
  try {
    body = (await request.json()) as ReminderBody;
  } catch {
    return NextResponse.json({ error: "Invalid JSON." }, { status: 400 });
  }

  const channel = body.channel === "sms" || body.channel === "copy" ? body.channel : null;
  if (!channel) {
    return NextResponse.json({ error: "channel must be 'sms' or 'copy'." }, { status: 400 });
  }

  const { dealer } = await requireDealer();
  const sb = await createServerSupabase();
  const convRes = await sb
    .from("conversations")
    .select("*")
    .eq("id", id)
    .eq("dealer_id", dealer.id)
    .maybeSingle();
  const conversation = convRes.data as ConversationRow | null;
  if (!conversation) return NextResponse.json({ error: "Not found." }, { status: 404 });

  const text = reminderText(dealer.name, conversation.language);

  if (channel === "copy") {
    return NextResponse.json({ ok: true, text, sent: false });
  }

  // SMS path. Belt-and-braces guards.
  if (!smsEnabled()) {
    return NextResponse.json({ error: "SMS is disabled for this deployment." }, { status: 400 });
  }
  if (!dealer.sms_number) {
    return NextResponse.json({ error: "Set your dealership SMS number in Settings first." }, { status: 400 });
  }
  if (!conversation.buyer_phone) {
    return NextResponse.json({ error: "This buyer never sent us their phone number — copy the text instead." }, { status: 400 });
  }

  const send = await sendSms({ to: conversation.buyer_phone, body: text });
  if (!send.queued) {
    log.warn("reminder.sms_failed", {
      conversation_id: conversation.id,
      detail: send.error ?? "unknown",
    });
    return NextResponse.json({ error: "Could not send SMS." }, { status: 503 });
  }

  const insertRes = await sb.from("messages").insert({
    conversation_id: conversation.id,
    role: "dealer",
    body: text,
    intent: "test_drive",
    language: conversation.language,
    approval_status: "sent",
    delivery_channel: "sms",
    delivery_sid: send.sid ?? null,
  });
  if (insertRes.error) {
    log.error("reminder.message_insert_failed", { code: insertRes.error.code });
  }

  revalidatePath("/dashboard");
  revalidatePath(`/dashboard/inbox/${conversation.id}`);

  return NextResponse.json({ ok: true, sent: true, sid: send.sid, text });
}
