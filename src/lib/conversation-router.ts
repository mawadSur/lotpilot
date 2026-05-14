// Find-or-create the conversation row for an inbound message, keyed by
// (dealer_id, channel, buyer_phone) — or by buyer_session when no phone
// is available. v0.3.1 carry-over E3: kills the duplicated lookup +
// insert that lived in /api/sms/inbound and /api/voice/inbound, both of
// which had to remember to filter by `channel` to dodge the
// dealer_id+buyer_phone collision a buyer hits when they both text and
// call the same dealership.
//
// Channel filter is unconditional. Without it, a buyer who texts a
// dealer (channel='sms', conversation row #1) and then calls them
// (channel='voice', row #2 wanted) would either match row #1 — wrong,
// because the voice transcript would land in the SMS thread — or
// PGRST116 if maybeSingle saw two rows. The unique
// (dealer_id, buyer_session) constraint on conversations means the
// channel-prefixed buyer_session each adapter passes is enough to keep
// rows distinct on insert.

import type { SupabaseClient } from "@supabase/supabase-js";
import type {
  ChatChannel,
  ConversationRow,
  DealerRow,
  Lang,
} from "./db-types";
import { log } from "./log";

export interface FindOrCreateInput {
  sb: SupabaseClient;
  dealer: DealerRow;
  channel: ChatChannel;
  buyerSession: string;
  buyerPhone: string | null;
  language?: Lang;
  requestId: string;
}

export interface FindOrCreateResult {
  conversation: ConversationRow;
  isNew: boolean;
}

export class ConversationRouterError extends Error {
  constructor(message: string, public readonly code?: string) {
    super(message);
    this.name = "ConversationRouterError";
  }
}

export async function findOrCreateConversation(
  input: FindOrCreateInput,
): Promise<FindOrCreateResult> {
  const { sb, dealer, channel, buyerSession, buyerPhone, requestId } = input;
  const language: Lang = input.language ?? "en";

  // Lookup. Prefer dealer_id + channel + buyer_phone when we have a
  // phone (SMS, voice). Fall back to dealer_id + buyer_session when we
  // don't (web widget, relay drafts, future channels). Channel filter
  // is always applied — see file header for why.
  let lookup = sb
    .from("conversations")
    .select("*")
    .eq("dealer_id", dealer.id)
    .eq("channel", channel);
  lookup = buyerPhone
    ? lookup.eq("buyer_phone", buyerPhone)
    : lookup.eq("buyer_session", buyerSession);

  const lookupRes = await lookup.maybeSingle();
  if (lookupRes.error) {
    log.warn("conv_router.lookup_failed", {
      requestId,
      dealer_id: dealer.id,
      channel,
      code: lookupRes.error.code,
    });
    throw new ConversationRouterError(
      `Conversation lookup failed: ${lookupRes.error.message}`,
      lookupRes.error.code,
    );
  }

  const existing = lookupRes.data as ConversationRow | null;
  if (existing) {
    return { conversation: existing, isNew: false };
  }

  // Insert. We let the unique (dealer_id, buyer_session) constraint
  // backstop a parallel-first-message race; the second writer hits
  // 23505, retries the lookup once, and returns the row the first
  // writer just inserted.
  const insertRes = await sb
    .from("conversations")
    .insert({
      dealer_id: dealer.id,
      buyer_session: buyerSession,
      language,
      status: "open",
      channel,
      buyer_phone: buyerPhone,
      lead_status: "new",
    })
    .select("*")
    .single();

  if (insertRes.error || !insertRes.data) {
    if (insertRes.error?.code === "23505") {
      // Race: another writer inserted between our lookup and insert.
      // Re-read and return that row.
      let retry = sb
        .from("conversations")
        .select("*")
        .eq("dealer_id", dealer.id)
        .eq("channel", channel);
      retry = buyerPhone
        ? retry.eq("buyer_phone", buyerPhone)
        : retry.eq("buyer_session", buyerSession);
      const retryRes = await retry.maybeSingle();
      const row = retryRes.data as ConversationRow | null;
      if (row) {
        return { conversation: row, isNew: false };
      }
    }
    log.error("conv_router.insert_failed", {
      requestId,
      dealer_id: dealer.id,
      channel,
      code: insertRes.error?.code,
    });
    throw new ConversationRouterError(
      `Conversation insert failed: ${insertRes.error?.message ?? "no data"}`,
      insertRes.error?.code,
    );
  }

  return { conversation: insertRes.data as ConversationRow, isNew: true };
}
