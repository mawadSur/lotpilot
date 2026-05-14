"use server";

import { revalidatePath } from "next/cache";
import { requireDealer } from "@/lib/auth";
import { createServerSupabase } from "@/lib/supabase-server";
import { log } from "@/lib/log";
import type { ConversationRow, LeadStatus } from "@/lib/db-types";

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

  revalidatePath("/dashboard");
  revalidatePath("/dashboard/inbox");
  revalidatePath(`/dashboard/inbox/${conversationId}`);
  return { status: "ok" };
}
