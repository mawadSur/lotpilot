// Buyer polling endpoint for the approve-before-send queue. The widget
// hits this every ~6s when the previous response said `pendingApproval`,
// up to 5 minutes / 50 polls / tab-visible.
//
// Contract:
//   GET ?conversationId=<uuid>&since=<iso8601>
//   200 { messages: [{ id, role, body, created_at }] }
//   400 { error }
//   404 { error }   — conversation doesn't match cookie (defensive: never 403)
//   429 { error }   — burst polling
//
// Filters AI messages to approval_status IN ('approved','auto','sent')
// — pending and rejected are dealer-only.

import { NextResponse, type NextRequest } from "next/server";
import { createServiceSupabase } from "@/lib/supabase-service";
import { BUYER_SESSION_COOKIE, isValidBuyerSession } from "@/lib/session";
import { checkRate } from "@/lib/ratelimit";
import { log } from "@/lib/log";
import { supabaseServiceConfigured } from "@/lib/env";
import type { ConversationRow, MessageRow } from "@/lib/db-types";

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

function bad(status: number, error: string): NextResponse {
  return NextResponse.json({ error }, { status, headers: { "cache-control": "no-store" } });
}

export async function GET(request: NextRequest) {
  if (!supabaseServiceConfigured) {
    return bad(503, "Service temporarily unavailable.");
  }

  const url = request.nextUrl;
  const conversationId = url.searchParams.get("conversationId") ?? "";
  const sinceParam = url.searchParams.get("since") ?? "";

  if (!UUID_RE.test(conversationId)) return bad(400, "Invalid conversationId.");

  const since = sinceParam ? new Date(sinceParam) : new Date(Date.now() - 5 * 60 * 1000);
  if (Number.isNaN(since.getTime())) return bad(400, "Invalid since.");

  const limit = await checkRate("conversation", conversationId);
  if (!limit.ok) {
    log.warn("chat.poll_rate_limited", { conversation_id: conversationId, reset_sec: limit.resetSec });
    return NextResponse.json(
      { error: "Polling too fast." },
      { status: 429, headers: { "retry-after": String(limit.resetSec), "cache-control": "no-store" } },
    );
  }

  const cookieValue = request.cookies.get(BUYER_SESSION_COOKIE)?.value;
  if (!isValidBuyerSession(cookieValue)) return bad(404, "Conversation not found.");

  const sb = createServiceSupabase();

  // Validate cookie matches the conversation row — never 403; a 403
  // would tell an attacker the conversation exists.
  const convRes = await sb
    .from("conversations")
    .select("id,buyer_session")
    .eq("id", conversationId)
    .maybeSingle();
  const conv = convRes.data as Pick<ConversationRow, "id" | "buyer_session"> | null;
  if (!conv || conv.buyer_session !== cookieValue) {
    return bad(404, "Conversation not found.");
  }

  const msgRes = await sb
    .from("messages")
    .select("id,role,body,created_at,approval_status")
    .eq("conversation_id", conversationId)
    .eq("role", "ai")
    .in("approval_status", ["approved", "auto", "sent"])
    .gt("created_at", since.toISOString())
    .order("created_at", { ascending: true })
    .limit(20);

  const rows = (msgRes.data ?? []) as Pick<MessageRow, "id" | "role" | "body" | "created_at">[];

  return NextResponse.json(
    {
      messages: rows.map((m) => ({ id: m.id, role: m.role, body: m.body, created_at: m.created_at })),
    },
    { headers: { "cache-control": "no-store" } },
  );
}
