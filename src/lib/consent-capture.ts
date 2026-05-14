// First-turn TCPA consent capture, extracted from chat-pipeline.ts so
// that file stays under the 500-line ceiling and the per-channel rules
// have a single home.
//
// Per-channel rules:
//   relay: skip entirely. The relay channel is dealer-internal — the
//          dealer pastes a buyer message they got out-of-band, so there
//          is no first-party LotPilot contact to record. The v0.3.1
//          carry-over C3 fix.
//   voice: TCPA-compliant voice copy (call-recording + AI-processing
//          notice). ip+ua nulled because phone callers never have a
//          browser; buyer_phone is the audit anchor.
//   sms / web: existing copy from v0.2.

import {
  smsConsentText,
  voiceConsentText,
  webWidgetConsentText,
} from "./consent";
import { log } from "./log";
import type { SupabaseClient } from "@supabase/supabase-js";
import type { ChatChannel, ConversationRow, DealerRow } from "./db-types";

export interface CaptureConsentArgs {
  sb: SupabaseClient;
  dealer: DealerRow;
  conversation: ConversationRow;
  channel: ChatChannel;
  ip: string;
  userAgent: string | null;
  buyerPhone: string | null;
  requestId: string;
}

export async function captureFirstTurnConsent(args: CaptureConsentArgs): Promise<void> {
  const { sb, dealer, conversation, channel, ip, userAgent, buyerPhone, requestId } = args;

  if (channel === "relay") {
    log.info("relay.consent_skipped", {
      requestId,
      dealer_id: dealer.id,
      conversation_id: conversation.id,
    });
    return;
  }

  const consentText =
    channel === "sms"
      ? smsConsentText(dealer.name)
      : channel === "voice"
        ? voiceConsentText(dealer.name)
        : webWidgetConsentText(dealer.name);

  // Voice never has a browser IP/UA; null both so the inet CHECK
  // can't trip. buyer_phone is the audit-trail anchor for that channel.
  const ipForRow =
    channel === "voice" ? null : ip === "unknown" ? null : ip;
  const userAgentForRow =
    channel === "voice"
      ? null
      : userAgent
        ? userAgent.slice(0, 500)
        : null;

  const consentRes = await sb.from("consents").insert({
    dealer_id: dealer.id,
    conversation_id: conversation.id,
    channel,
    consent_text: consentText,
    ip_address: ipForRow,
    user_agent: userAgentForRow,
    buyer_phone: buyerPhone,
  });
  // 23505 = unique_violation: a near-simultaneous twin first-message
  // race already wrote the consent row. The audit trail is intact;
  // skip the warn so we don't pollute logs with expected races.
  if (consentRes.error && consentRes.error.code !== "23505") {
    log.warn("chat.consent_insert_failed", {
      requestId,
      code: consentRes.error.code,
    });
  }
}
