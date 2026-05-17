"use server";

import { revalidatePath } from "next/cache";
import { requireDealer } from "@/lib/auth";
import { createServerSupabase } from "@/lib/supabase-server";
import { createServiceSupabase } from "@/lib/supabase-service";
import { cancelFollowUps } from "@/lib/follow-up/scheduler";
import { initiateLeadShare } from "@/lib/lead-share/initiate";
import { log } from "@/lib/log";
import type { ConversationRow, DealerRow, LeadStatus } from "@/lib/db-types";

export type ConversationActionState =
  | { status: "idle" }
  | { status: "ok" }
  | { status: "error"; message: string };

const VALID_STATUSES: ReadonlySet<LeadStatus> = new Set([
  "new",
  "qualified",
  "booked",
  "sold",
  "lost",
]);
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

interface ConversationPatch {
  lead_status?: LeadStatus;
  notes?: string | null;
  assigned_user_id?: string | null;
}

export async function updateConversation(
  conversationId: string,
  patch: ConversationPatch,
): Promise<ConversationActionState> {
  if (!UUID_RE.test(conversationId)) {
    return { status: "error", message: "Invalid conversation id." };
  }

  const { dealer, user } = await requireDealer();

  const update: Partial<ConversationRow> = {};

  if (patch.lead_status !== undefined) {
    if (!VALID_STATUSES.has(patch.lead_status)) {
      return { status: "error", message: "Invalid lead status." };
    }
    update.lead_status = patch.lead_status;
  }
  if (patch.notes !== undefined) {
    if (patch.notes !== null && (typeof patch.notes !== "string" || patch.notes.length > 4000)) {
      return { status: "error", message: "Notes are too long (max 4000 chars)." };
    }
    update.notes = patch.notes ? patch.notes.trim() : null;
  }
  if (patch.assigned_user_id !== undefined) {
    if (patch.assigned_user_id === null) {
      update.assigned_user_id = null;
    } else if (typeof patch.assigned_user_id === "string" && UUID_RE.test(patch.assigned_user_id)) {
      // v0.2: only the owner may self-assign. Multi-user assignment is
      // gated on a `dealer_users` table that ships in v0.3.
      if (patch.assigned_user_id !== user.id) {
        return { status: "error", message: "You can only assign yourself in v0.2." };
      }
      update.assigned_user_id = user.id;
    } else {
      return { status: "error", message: "Invalid assignee id." };
    }
  }

  if (Object.keys(update).length === 0) {
    return { status: "ok" };
  }

  const sb = await createServerSupabase();
  const res = await sb
    .from("conversations")
    .update(update)
    .eq("id", conversationId)
    .eq("dealer_id", dealer.id);

  if (res.error) {
    log.error("conversation.update_failed", {
      dealer_id: dealer.id,
      conversation_id: conversationId,
      detail: res.error.message,
    });
    return { status: "error", message: "Could not update. Please try again." };
  }

  // T1.9: when the dealer marks the lead sold or lost, cancel every
  // open post-test-drive follow-up for the conversation. follow_up_jobs
  // has no authenticated UPDATE policy (service-role-only mutation), so
  // we switch to the service client here. The user-scoped update above
  // already confirmed the caller owns this dealer's row, so the
  // service-role call is a contained second hop with no auth-bypass risk.
  if (
    update.lead_status === "sold" ||
    update.lead_status === "lost"
  ) {
    const svcSb = createServiceSupabase();
    await cancelFollowUps({
      sb: svcSb,
      conversationId,
      reason: update.lead_status === "sold" ? "lead_sold" : "lead_lost",
    });
  }

  revalidatePath("/dashboard");
  revalidatePath("/dashboard/inbox");
  revalidatePath(`/dashboard/inbox/${conversationId}`);
  return { status: "ok" };
}

// T4.2 — Share a conversation with another dealer in the network.
//
// Authentication: requireDealer (the caller). Same auth-confirm-then-
// service-role hop as updateConversation's sold/lost path. We do a
// fresh authenticated SELECT to prove the conversation belongs to the
// caller's dealer BEFORE handing off to the service role — defence in
// depth against a forged conversation id in the request body.
//
// The cap on `notes` matches the migration column (500 chars).
const SHARE_NOTES_MAX = 500;
const SLUG_RE = /^[a-z0-9][a-z0-9-]{0,79}$/;

export type LeadShareActionState =
  | { status: "ok"; leadShareId: string }
  | { status: "error"; message: string };

export async function shareLead(
  conversationId: string,
  targetDealerSlug: string,
  notes: string | null,
): Promise<LeadShareActionState> {
  if (!UUID_RE.test(conversationId)) {
    return { status: "error", message: "Invalid conversation id." };
  }
  const slugNormalised = targetDealerSlug.trim().toLowerCase();
  if (!SLUG_RE.test(slugNormalised)) {
    return { status: "error", message: "Invalid target dealer slug." };
  }
  if (notes !== null && (typeof notes !== "string" || notes.length > SHARE_NOTES_MAX)) {
    return { status: "error", message: `Notes are too long (max ${SHARE_NOTES_MAX} chars).` };
  }

  const { dealer, user } = await requireDealer();

  // Authenticated ownership check — RLS would already block reading
  // someone else's conversation, but a clean error message is friendlier
  // than a generic "not found".
  const sb = await createServerSupabase();
  const ownRes = await sb
    .from("conversations")
    .select("*")
    .eq("id", conversationId)
    .eq("dealer_id", dealer.id)
    .maybeSingle();
  const conversation = ownRes.data as ConversationRow | null;
  if (!conversation) {
    return { status: "error", message: "Conversation not found." };
  }

  // Service-role hand-off. The lead_shares table has no authenticated
  // INSERT/UPDATE policy (migration 0017 RAISE EXCEPTION enforces);
  // initiateLeadShare also writes a 'dealer' role message into the
  // source conversation (which the user CAN do via RLS), but we keep
  // the whole flow on the service client so the SMS-send transition
  // stays atomic.
  const svcSb = createServiceSupabase();
  const result = await initiateLeadShare({
    sb: svcSb,
    sourceDealer: dealer as DealerRow,
    sourceConversation: conversation,
    targetDealerSlug: slugNormalised,
    createdByUserId: user.id,
    notes: notes ?? undefined,
  });

  if (!result.ok) {
    log.warn("lead_share.initiate_rejected", {
      dealer_id: dealer.id,
      conversation_id: conversationId,
      target_slug: slugNormalised,
      reason: result.reason,
    });
    // Map service-layer reasons to user-facing copy. Unknown reasons
    // fall through to a generic message to avoid leaking internals.
    const friendly: Record<string, string> = {
      target_dealer_not_found: "Could not find that dealer.",
      self_share: "You can't share a lead to yourself.",
      channel_unsupported: "Lead sharing is SMS-only in this release.",
      sms_not_configured: "SMS isn't configured for your account.",
      no_buyer_phone: "This buyer has no phone number on file.",
      suppressed: "This buyer opted out — we can't message them.",
      no_consent: "We don't have SMS consent from this buyer.",
      already_pending: "A share for this conversation is already pending.",
      sms_send_failed: "We couldn't send the consent SMS. Please try again.",
    };
    const message = friendly[result.reason as string] ?? "Could not share. Please try again.";
    return { status: "error", message };
  }

  revalidatePath("/dashboard/inbox");
  revalidatePath(`/dashboard/inbox/${conversationId}`);
  return { status: "ok", leadShareId: result.leadShareId };
}
