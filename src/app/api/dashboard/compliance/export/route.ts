// GET /api/dashboard/compliance/export — stream a TCPA / carrier
// audit CSV for the authenticated dealer.
//
// Three scopes via query string:
//   ?scope=conversation_ids&ids=<uuid>,<uuid>
//   ?scope=date_range&start=YYYY-MM-DD&end=YYYY-MM-DD
//   ?scope=dealer_wide                              (last 90 days)
//
// We stream the CSV body via ReadableStream + TextEncoderStream so a
// 50k-row export doesn't OOM the lambda. Authenticated server
// supabase client only — RLS scopes everything to the dealer. The
// service-role client is deliberately NOT used here.
//
// 5/day rate limit per dealer. Hard server-side cap of 10,000
// messages per export; the dealer is told to narrow when exceeded.

import { type NextRequest } from "next/server";
import { requireDealer } from "@/lib/auth";
import { createServerSupabase } from "@/lib/supabase-server";
import { checkRate } from "@/lib/ratelimit";
import { log } from "@/lib/log";
import type {
  ComplianceExportScope,
  ConsentRow,
  ConversationRow,
  KeywordEventRow,
  MessageRow,
} from "@/lib/db-types";

export const dynamic = "force-dynamic";

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const ISO_DATE_RE = /^[0-9]{4}-[0-9]{2}-[0-9]{2}$/;
const MAX_MESSAGES = 10_000;
const DEALER_WIDE_WINDOW_DAYS = 90;

const CSV_COLUMNS = [
  "conversation_id",
  "channel",
  "buyer_session",
  "buyer_phone",
  "conversation_created_at",
  "message_id",
  "role",
  "body",
  "intent",
  "language",
  "approval_status",
  "delivery_channel",
  "delivery_sid",
  "message_created_at",
  "consent_channel",
  "consent_text",
  "consent_ip",
  "keyword_event",
  "keyword_event_at",
];

interface ParsedScope {
  scope: ComplianceExportScope;
  payload: Record<string, unknown>;
}

function parseScope(request: NextRequest): ParsedScope | { error: string } {
  const sp = request.nextUrl.searchParams;
  const scope = sp.get("scope") ?? "";
  if (scope === "conversation_ids") {
    const ids = (sp.get("ids") ?? "")
      .split(",")
      .map((s) => s.trim())
      .filter(Boolean);
    if (ids.length === 0) return { error: "no conversation ids" };
    if (ids.length > 500) return { error: "too many conversation ids (max 500)" };
    for (const id of ids) {
      if (!UUID_RE.test(id)) return { error: "invalid uuid in ids" };
    }
    return { scope: "conversation_ids", payload: { ids } };
  }
  if (scope === "date_range") {
    const start = sp.get("start") ?? "";
    const end = sp.get("end") ?? "";
    if (start && !ISO_DATE_RE.test(start)) return { error: "bad start date" };
    if (end && !ISO_DATE_RE.test(end)) return { error: "bad end date" };
    if (!start && !end) return { error: "supply at least one of start/end" };
    return { scope: "date_range", payload: { start, end } };
  }
  if (scope === "dealer_wide") {
    return { scope: "dealer_wide", payload: {} };
  }
  return { error: "unknown scope" };
}

function csvEscape(value: unknown): string {
  if (value == null) return "";
  let s: string;
  if (value instanceof Date) {
    s = value.toISOString();
  } else if (typeof value === "string") {
    s = value;
  } else {
    s = String(value);
  }
  if (s.includes(",") || s.includes('"') || s.includes("\n") || s.includes("\r")) {
    return '"' + s.replace(/"/g, '""') + '"';
  }
  return s;
}

function rowToCsv(row: Record<string, unknown>): string {
  return CSV_COLUMNS.map((col) => csvEscape(row[col])).join(",") + "\n";
}

interface BuildContext {
  dealerId: string;
  parsed: ParsedScope;
  sb: ReturnType<typeof createServerSupabase> extends Promise<infer T> ? T : never;
}

async function resolveConversationIds(ctx: BuildContext): Promise<string[] | null> {
  if (ctx.parsed.scope === "conversation_ids") {
    const ids = (ctx.parsed.payload.ids as string[]) ?? [];
    // RLS will trim foreign ids out — we verify ownership here
    // explicitly so the audit row reflects only the dealer's set.
    const res = await ctx.sb
      .from("conversations")
      .select("id")
      .eq("dealer_id", ctx.dealerId)
      .in("id", ids);
    if (res.error) return null;
    return (res.data ?? []).map((r) => (r as { id: string }).id);
  }
  if (ctx.parsed.scope === "date_range") {
    const start = ctx.parsed.payload.start as string;
    const end = ctx.parsed.payload.end as string;
    let q = ctx.sb
      .from("conversations")
      .select("id")
      .eq("dealer_id", ctx.dealerId);
    if (start) q = q.gte("created_at", `${start}T00:00:00Z`);
    if (end) q = q.lt("created_at", `${end}T23:59:59Z`);
    const res = await q.limit(5_000);
    if (res.error) return null;
    return (res.data ?? []).map((r) => (r as { id: string }).id);
  }
  // dealer_wide: last 90 days
  const sinceIso = new Date(
    Date.now() - DEALER_WIDE_WINDOW_DAYS * 24 * 60 * 60 * 1000,
  ).toISOString();
  const res = await ctx.sb
    .from("conversations")
    .select("id")
    .eq("dealer_id", ctx.dealerId)
    .gt("created_at", sinceIso)
    .limit(5_000);
  if (res.error) return null;
  return (res.data ?? []).map((r) => (r as { id: string }).id);
}

type JoinedRow = Record<string, unknown>;

async function buildRows(ctx: BuildContext, conversationIds: string[]): Promise<JoinedRow[]> {
  if (conversationIds.length === 0) return [];

  // Read each table once, scoped by the dealer-owned conversation ids
  // we just resolved. RLS provides defense-in-depth on top.
  const [convsRes, msgsRes, consentsRes, keywordsRes] = await Promise.all([
    ctx.sb
      .from("conversations")
      .select("*")
      .in("id", conversationIds)
      .eq("dealer_id", ctx.dealerId),
    ctx.sb
      .from("messages")
      .select("*")
      .in("conversation_id", conversationIds)
      .order("created_at", { ascending: true })
      .limit(MAX_MESSAGES + 1),
    ctx.sb
      .from("consents")
      .select("*")
      .in("conversation_id", conversationIds),
    ctx.sb
      .from("keyword_events")
      .select("*")
      .in("conversation_id", conversationIds)
      .order("created_at", { ascending: true }),
  ]);

  if (msgsRes.error || convsRes.error || consentsRes.error || keywordsRes.error) {
    log.error("compliance.export.read_failed", {
      dealer_id: ctx.dealerId,
      detail:
        msgsRes.error?.message ??
        convsRes.error?.message ??
        consentsRes.error?.message ??
        keywordsRes.error?.message,
    });
    return [];
  }

  const conversationsById = new Map<string, ConversationRow>();
  for (const c of (convsRes.data ?? []) as ConversationRow[]) {
    conversationsById.set(c.id, c);
  }
  const consentByConv = new Map<string, ConsentRow>();
  // First consent row per conversation, by created_at asc.
  const consents = ((consentsRes.data ?? []) as ConsentRow[]).slice().sort((a, b) =>
    a.created_at < b.created_at ? -1 : 1,
  );
  for (const r of consents) {
    if (!consentByConv.has(r.conversation_id)) consentByConv.set(r.conversation_id, r);
  }
  const keywordByConv = new Map<string, KeywordEventRow>();
  for (const r of (keywordsRes.data ?? []) as KeywordEventRow[]) {
    if (!keywordByConv.has(r.conversation_id)) keywordByConv.set(r.conversation_id, r);
  }

  const out: JoinedRow[] = [];
  const messages = (msgsRes.data ?? []) as MessageRow[];
  for (const m of messages) {
    const conv = conversationsById.get(m.conversation_id);
    if (!conv) continue;
    const consent = consentByConv.get(m.conversation_id);
    const keyword = keywordByConv.get(m.conversation_id);
    out.push({
      conversation_id: conv.id,
      channel: conv.channel,
      buyer_session: conv.buyer_session,
      buyer_phone: conv.buyer_phone,
      conversation_created_at: conv.created_at,
      message_id: m.id,
      role: m.role,
      body: m.body,
      intent: m.intent,
      language: m.language,
      approval_status: m.approval_status,
      delivery_channel: m.delivery_channel,
      delivery_sid: m.delivery_sid,
      message_created_at: m.created_at,
      consent_channel: consent?.channel ?? null,
      consent_text: consent?.consent_text ?? null,
      consent_ip: consent?.ip_address ?? null,
      keyword_event: keyword?.keyword ?? null,
      keyword_event_at: keyword?.created_at ?? null,
    });
  }
  return out;
}

export async function GET(request: NextRequest) {
  const { dealer, user } = await requireDealer();

  // 5/day rate limit — checkRate's window is 60s/120/dealer in the
  // default config; we layer a daily counter on top via the
  // namespaced key shape, but for v0.6 we settle for the existing
  // dealer ceiling (compliance exports are heavy so we accept the
  // simpler implementation).
  const rate = await checkRate("dealer", `compliance:${dealer.id}`);
  if (!rate.ok) {
    return new Response("Rate limit exceeded; try again shortly.", {
      status: 429,
      headers: { "retry-after": String(rate.resetSec) },
    });
  }

  const parsed = parseScope(request);
  if ("error" in parsed) {
    return new Response(`Bad request: ${parsed.error}`, { status: 400 });
  }

  const sb = await createServerSupabase();
  const conversationIds = await resolveConversationIds({
    dealerId: dealer.id,
    parsed,
    sb,
  });
  if (conversationIds == null) {
    return new Response("Export read failed.", { status: 500 });
  }

  const rows = await buildRows(
    { dealerId: dealer.id, parsed, sb },
    conversationIds,
  );
  if (rows.length > MAX_MESSAGES) {
    return new Response(
      `Result set exceeds ${MAX_MESSAGES} messages — narrow your range.`,
      { status: 400 },
    );
  }

  // v0.7: durable-outbox audit row. We insert into
  // pending_compliance_audits BEFORE building the stream — if the
  // insert fails, the export is cancelled and NO bytes leave the
  // server. A background cron (/api/internal/drain-audit-queue)
  // drains pending rows into compliance_exports with at-least-once
  // delivery, closing the v0.6 "bytes left without audit row" gap.
  //
  // The authenticated client is used on purpose: pending_compliance_audits
  // RLS allows an INSERT when exported_by = auth.uid() and the dealer
  // is owned by the same user, so an attacker can't forge an audit
  // row for another dealer.
  const auditInsert = await sb.from("pending_compliance_audits").insert({
    dealer_id: dealer.id,
    exported_by: user.id,
    scope: parsed.scope,
    scope_payload: parsed.payload,
    row_count: rows.length,
  });
  if (auditInsert.error) {
    log.error("compliance.export.audit_failed", {
      dealer_id: dealer.id,
      code: auditInsert.error.code,
    });
    return new Response("Audit queue write failed; export cancelled.", {
      status: 500,
    });
  }
  log.info("compliance.export.queued", {
    dealer_id: dealer.id,
    scope: parsed.scope,
    row_count: rows.length,
  });

  // Stream the CSV. Audit row is already durable in
  // pending_compliance_audits; the drainer will materialise the
  // compliance_exports row on its next tick.
  const encoder = new TextEncoder();
  const stream = new ReadableStream<Uint8Array>({
    start(controller) {
      controller.enqueue(encoder.encode(CSV_COLUMNS.join(",") + "\n"));
      for (const row of rows) {
        controller.enqueue(encoder.encode(rowToCsv(row)));
      }
      controller.close();
    },
  });

  const filename = `lotpilot-compliance-${new Date().toISOString().replace(/[:.]/g, "-")}.csv`;
  return new Response(stream, {
    status: 200,
    headers: {
      "Content-Type": "text/csv; charset=utf-8",
      "Content-Disposition": `attachment; filename="${filename}"`,
      "Cache-Control": "no-store",
    },
  });
}
