// Channel-specific outbound delivery for the chat pipeline. Extracted
// out of chat-pipeline.ts to keep that file under the 500-line cap +
// to localise the per-channel logic (SMS vs. WhatsApp send + retry +
// warning row patterns).
//
// SMS: existing Twilio path. Update delivery_sid + flip
// approval_status='sent' on a queued send.
//
// WhatsApp: Meta Cloud API path with 24h-window + template fallback.
// Failed sends leave approval_status='auto' (no rewrite — the dealer
// can still hand-reply from the inbox) and emit a system_warnings
// row on the discriminating error codes (auth_failed,
// window_closed_template_unverified).

import type { SupabaseClient } from "@supabase/supabase-js";
import { sendSms, maskPhone } from "./sms/twilio";
import { sendWhatsAppMessage } from "./whatsapp/cloud-api";
import { log } from "./log";
import type { ChatChannel, DealerRow, SystemWarningKind } from "./db-types";

export interface OutboundDispatchArgs {
  sb: SupabaseClient;
  channel: ChatChannel;
  dealer: DealerRow;
  conversationId: string;
  buyerPhone: string | null;
  savedMessageId: string;
  finalReply: string;
  requestId: string;
}

export async function dispatchOutbound(args: OutboundDispatchArgs): Promise<void> {
  if (!args.buyerPhone) return;

  if (args.channel === "sms") {
    const send = await sendSms({ to: args.buyerPhone, body: args.finalReply });
    if (send.queued && send.sid) {
      await args.sb
        .from("messages")
        .update({ delivery_sid: send.sid, approval_status: "sent" })
        .eq("id", args.savedMessageId);
    }
    return;
  }

  if (args.channel === "whatsapp") {
    const send = await sendWhatsAppMessage({
      to: args.buyerPhone,
      body: args.finalReply,
      conversationId: args.conversationId,
      sb: args.sb,
    });
    if (send.queued && send.messageId) {
      await args.sb
        .from("messages")
        .update({ delivery_sid: send.messageId, approval_status: "sent" })
        .eq("id", args.savedMessageId);
      return;
    }
    log.warn("whatsapp.send_failed", {
      requestId: args.requestId,
      dealer_id: args.dealer.id,
      conversation_id: args.conversationId,
      error: send.error,
      to_redacted: maskPhone(args.buyerPhone),
    });
    if (send.raiseWarning) {
      const warningKind: SystemWarningKind =
        send.error === "auth_failed"
          ? "whatsapp_auth_failed"
          : "whatsapp_window_closed";
      await args.sb.from("system_warnings").insert({
        dealer_id: args.dealer.id,
        kind: warningKind,
        payload: {
          conversation_id: args.conversationId,
          error: send.error,
        },
      });
    }
  }
}
