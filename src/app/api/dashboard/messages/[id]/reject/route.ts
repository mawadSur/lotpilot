// Dealer-only: reject a pending AI message draft. Kept in DB for audit.

import { NextResponse, type NextRequest } from "next/server";
import { revalidatePath } from "next/cache";
import { requireDealer } from "@/lib/auth";
import { createServerSupabase } from "@/lib/supabase-server";
import { log } from "@/lib/log";
import type { MessageRow } from "@/lib/db-types";

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

interface PageContext {
  params: Promise<{ id: string }>;
}

export async function POST(_request: NextRequest, ctx: PageContext) {
  const { id } = await ctx.params;
  if (!UUID_RE.test(id)) {
    return NextResponse.json({ error: "Invalid id." }, { status: 400 });
  }

  const { user, dealer } = await requireDealer();
  const sb = await createServerSupabase();

  const msgRes = await sb
    .from("messages")
    .select("id,conversation_id,role,approval_status")
    .eq("id", id)
    .maybeSingle();
  const msg = msgRes.data as Pick<MessageRow, "id" | "conversation_id" | "role" | "approval_status"> | null;
  if (!msg) return NextResponse.json({ error: "Not found." }, { status: 404 });
  if (msg.role !== "ai") {
    return NextResponse.json({ error: "Only AI drafts can be rejected." }, { status: 400 });
  }
  if (msg.approval_status !== "pending") {
    if (msg.approval_status === "rejected") {
      return NextResponse.json({ ok: true, message: msg });
    }
    return NextResponse.json({ error: `Cannot reject a ${msg.approval_status} message.` }, { status: 400 });
  }

  const updateRes = await sb
    .from("messages")
    .update({
      approval_status: "rejected",
      approved_by: user.id,
      approved_at: new Date().toISOString(),
    })
    .eq("id", id)
    .select("id,conversation_id,role,approval_status")
    .single();

  if (updateRes.error || !updateRes.data) {
    log.error("messages.reject_failed", {
      dealer_id: dealer.id,
      message_id: id,
      detail: updateRes.error?.message,
    });
    return NextResponse.json({ error: "Could not reject message." }, { status: 503 });
  }

  revalidatePath(`/dashboard/inbox/${msg.conversation_id}`);
  revalidatePath("/dashboard/inbox");
  revalidatePath("/dashboard");

  return NextResponse.json({ ok: true, message: updateRes.data });
}
