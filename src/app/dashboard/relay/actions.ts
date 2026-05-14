"use server";

// Marketplace relay: dealer pastes a buyer message from Facebook
// Marketplace (or any other channel we don't yet integrate), gets back
// an AI-drafted reply they can copy and paste back. We persist both
// turns in a `channel='relay'` conversation so the inbox / SLA tile
// reflect them like any other lead.
//
// Two server actions. `generateRelayDraft` runs the chat pipeline and
// returns the draft text (without showing it to a buyer). The draft is
// already saved to the DB inside the pipeline as an AI message (with
// approval_status='auto', because the dealer is literally driving the
// request — there's no buyer-facing approval to gate on).
//
// `saveRelayToInbox` is a no-op at the action layer — the pipeline's
// own write IS the save — but we keep it as a future hook for v0.4
// when the dealer might want to flag a draft as "I sent this".

import { createHash, randomUUID } from "node:crypto";
import { revalidatePath } from "next/cache";
import { requireDealer } from "@/lib/auth";
import { createServiceSupabase } from "@/lib/supabase-service";
import { runChatTurn } from "@/lib/chat-pipeline";
import { log } from "@/lib/log";
import type { ConversationRow, DealerRow, Intent } from "@/lib/db-types";

const MAX_RAW_CHARS = 4000;
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export type RelayState =
  | { status: "idle" }
  | { status: "draft"; draft: string; intent: Intent | null; conversationId: string }
  | { status: "saved"; conversationId: string }
  | { status: "error"; message: string };

const ERR_GENERIC = "Could not generate a draft. Try again in a moment.";
const ERR_RATE = "You're generating drafts too quickly. Please wait.";
const ERR_BUDGET = "Daily AI budget reached. Try again after midnight UTC.";

function asString(formData: FormData, key: string): string {
  const v = formData.get(key);
  return typeof v === "string" ? v.trim() : "";
}

// Build a clone of the dealer with approve_before_send forced off.
// The dealer themselves is driving the relay; there's no upstream
// buyer to keep waiting on a pending draft, so the pipeline should
// always inline the AI text in the response.
function relayDealer(dealer: DealerRow): DealerRow {
  return { ...dealer, approve_before_send: false };
}

export async function generateRelayDraft(
  _prev: RelayState,
  formData: FormData,
): Promise<RelayState> {
  const requestId = randomUUID();
  const { dealer } = await requireDealer();

  const buyerText = asString(formData, "buyer_text");
  const vehicleId = asString(formData, "vehicle_id");

  if (buyerText.length === 0) {
    return { status: "error", message: "Paste the buyer's message first." };
  }
  if (buyerText.length > MAX_RAW_CHARS) {
    return { status: "error", message: `Buyer message is too long (max ${MAX_RAW_CHARS} chars).` };
  }
  if (vehicleId && !UUID_RE.test(vehicleId)) {
    return { status: "error", message: "Vehicle id is invalid." };
  }

  const sb = createServiceSupabase();

  // If a vehicle was picked, confirm it belongs to the calling dealer
  // BEFORE we touch the AI. Stops a curious dealer from probing
  // another dealer's stock numbers via this endpoint.
  let stockHint = "";
  if (vehicleId) {
    const veh = await sb
      .from("vehicles")
      .select("stock_number,year,make,model,trim,dealer_id")
      .eq("id", vehicleId)
      .maybeSingle();
    if (!veh.data || (veh.data as { dealer_id: string }).dealer_id !== dealer.id) {
      return { status: "error", message: "That vehicle isn't in your inventory." };
    }
    const v = veh.data as { stock_number: string; year: number | null; make: string | null; model: string | null; trim: string | null };
    const desc = [v.year, v.make, v.model, v.trim].filter(Boolean).join(" ");
    stockHint = `[Buyer is asking about stock #${v.stock_number}${desc ? ` — ${desc}` : ""}]\n\n`;
  }

  // Fresh conversation per draft. We cannot reuse a thread because the
  // dealer might be relaying messages from many different buyers
  // through the same UI; the only safe disambiguator is a UUID. The
  // buyer_session column requires 16..128 chars — 'relay:' + uuid fits.
  const buyerSession = `relay:${randomUUID()}`;
  // Hash the dealer + uuid into a deterministic identity hint; useful
  // for debugging duplicate-submit bugs without revealing the uuid in
  // logs.
  const sessionHash = createHash("sha256").update(`${dealer.id}:${buyerSession}`).digest("hex").slice(0, 12);

  const insertConv = await sb
    .from("conversations")
    .insert({
      dealer_id: dealer.id,
      buyer_session: buyerSession,
      language: "en",
      status: "open",
      channel: "relay",
      lead_status: "new",
    })
    .select("*")
    .single();

  if (insertConv.error || !insertConv.data) {
    log.error("relay.conv_create_failed", {
      requestId,
      dealer_id: dealer.id,
      code: insertConv.error?.code,
      session_hash: sessionHash,
    });
    return { status: "error", message: ERR_GENERIC };
  }
  const conversation = insertConv.data as ConversationRow;

  const result = await runChatTurn({
    dealer: relayDealer(dealer),
    conversation,
    rawBuyerMessage: `${stockHint}${buyerText}`,
    channel: "relay",
    ip: "relay",
    userAgent: null,
    buyerPhone: null,
    requestId,
  });

  if (result.kind === "rate_limited") {
    return { status: "error", message: ERR_RATE };
  }
  if (result.kind === "budget_exhausted") {
    return { status: "error", message: ERR_BUDGET };
  }
  if (result.kind === "ai_error" || result.kind === "save_error") {
    return { status: "error", message: ERR_GENERIC };
  }

  // The relay flow always returns an AI reply (approve_before_send is
  // forced off in the cloned dealer above), so result.reply is set.
  if (!result.reply) {
    log.warn("relay.no_reply_returned", {
      requestId,
      dealer_id: dealer.id,
      kind: result.kind,
    });
    return { status: "error", message: ERR_GENERIC };
  }

  revalidatePath("/dashboard");
  revalidatePath("/dashboard/inbox");

  return {
    status: "draft",
    draft: result.reply,
    intent: result.intent,
    conversationId: result.conversationId,
  };
}

// Reserved for future "mark as sent" semantics. Today the pipeline
// already wrote the AI message as approval_status='auto', so the
// relay row IS the saved record — nothing else to do beyond echoing
// state for the form. The FormData parameter is required by
// useActionState's signature even though we don't read it yet.
export async function saveRelayToInbox(
  prev: RelayState,
  formData: FormData,
): Promise<RelayState> {
  void formData; // see comment above; placeholder until v0.4.
  if (prev.status !== "draft") {
    return prev;
  }
  return { status: "saved", conversationId: prev.conversationId };
}
