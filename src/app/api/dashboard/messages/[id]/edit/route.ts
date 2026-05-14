// Dealer-only: edit + approve a pending AI draft. Stores the original
// body for audit, then approves the new text in one step.

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

interface EditBody {
  body?: unknown;
}

export async function POST(request: NextRequest, ctx: PageContext) {
  const { id } = await ctx.params;
  if (!UUID_RE.test(id)) {
    return NextResponse.json({ error: "Invalid id." }, { status: 400 });
  }

  let payload: EditBody;
  try {
    payload = (await request.json()) as EditBody;
  } catch {
    return NextResponse.json({ error: "Invalid JSON body." }, { status: 400 });
  }

  const newBody = typeof payload.body === "string" ? payload.body.trim() : "";
  if (!newBody) {
    return NextResponse.json({ error: "Body is empty." }, { status: 400 });
  }
  if (newBody.length > 8000) {
    return NextResponse.json({ error: "Body is too long (max 8000 chars)." }, { status: 400 });
  }

  const { user, dealer } = await requireDealer();
  const sb = await createServerSupabase();

  const msgRes = await sb
    .from("messages")
    .select("id,conversation_id,role,approval_status,body")
    .eq("id", id)
    .maybeSingle();
  const msg = msgRes.data as Pick<MessageRow, "id" | "conversation_id" | "role" | "approval_status" | "body"> | null;
  if (!msg) return NextResponse.json({ error: "Not found." }, { status: 404 });
  if (msg.role !== "ai") {
    return NextResponse.json({ error: "Only AI drafts can be edited." }, { status: 400 });
  }
  if (msg.approval_status !== "pending") {
    return NextResponse.json({ error: `Cannot edit a ${msg.approval_status} message.` }, { status: 400 });
  }

  const updateRes = await sb
    .from("messages")
    .update({
      body: newBody,
      original_body: msg.body,
      approval_status: "approved",
      approved_by: user.id,
      approved_at: new Date().toISOString(),
    })
    .eq("id", id)
    .select("id,conversation_id,role,approval_status,body")
    .single();

  if (updateRes.error || !updateRes.data) {
    log.error("messages.edit_failed", {
      dealer_id: dealer.id,
      message_id: id,
      detail: updateRes.error?.message,
    });
    return NextResponse.json({ error: "Could not edit message." }, { status: 503 });
  }

  revalidatePath(`/dashboard/inbox/${msg.conversation_id}`);
  revalidatePath("/dashboard/inbox");
  revalidatePath("/dashboard");

  return NextResponse.json({ ok: true, message: updateRes.data });
}
