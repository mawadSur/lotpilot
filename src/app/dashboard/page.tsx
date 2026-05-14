// Dashboard root: inbox snapshot + hot-buyer banner + test-drive
// reminder tiles. Uses conversations_with_latest to dodge the v0.1 N+1.

import Link from "next/link";
import { requireDealer } from "@/lib/auth";
import { createServerSupabase } from "@/lib/supabase-server";
import { smsEnabled } from "@/lib/env";
import type { ConversationWithLatestRow } from "@/lib/db-types";
import { ReminderTile } from "./reminder-tile";

export default async function DashboardHome() {
  const { dealer } = await requireDealer();
  const sb = await createServerSupabase();

  const { data: convData } = await sb
    .from("conversations_with_latest")
    .select("*")
    .eq("dealer_id", dealer.id)
    .order("updated_at", { ascending: false })
    .limit(10);

  const conversations = (convData ?? []) as ConversationWithLatestRow[];

  // Hot-buyer banner: ready_to_close, not yet won/lost, recent.
  const now = new Date();
  const fourHoursAgoIso = new Date(now.getTime() - 4 * 60 * 60 * 1000).toISOString();
  const { data: hotData } = await sb
    .from("conversations_with_latest")
    .select("*")
    .eq("dealer_id", dealer.id)
    .eq("last_intent", "ready_to_close")
    .not("lead_status", "in", '("sold","lost")')
    .gt("updated_at", fourHoursAgoIso)
    .order("updated_at", { ascending: false })
    .limit(10);

  const hot = (hotData ?? []) as ConversationWithLatestRow[];

  // Reminder candidates: test_drive, lead_status=booked, recent + no
  // dealer/auto reply in the last 4h. We do the "no recent reply" pass
  // in JS via a per-row count query — small N.
  const reminderCandidates = await loadReminderCandidates(sb, dealer.id);

  const publicUrl = `/c/${dealer.slug}`;
  const sms = smsEnabled();

  return (
    <div className="grid gap-6">
      {hot.length > 0 ? <HotBanner rows={hot} /> : null}

      <section className="rounded-2xl border border-zinc-200 bg-white p-5">
        <div className="flex flex-col gap-4 sm:flex-row sm:items-center sm:justify-between">
          <div>
            <p className="text-xs uppercase tracking-widest text-zinc-500">Your public chat link</p>
            <p className="mt-1 break-all font-mono text-sm text-zinc-900">{publicUrl}</p>
          </div>
          <Link
            href={publicUrl}
            target="_blank"
            rel="noreferrer"
            className="inline-flex h-9 items-center rounded-md border border-zinc-300 bg-white px-3 text-xs font-semibold text-zinc-900 hover:bg-zinc-50"
          >
            Open buyer view
          </Link>
        </div>
      </section>

      {reminderCandidates.length > 0 ? (
        <section className="grid gap-3">
          <header className="flex items-center justify-between">
            <h2 className="text-lg font-semibold tracking-tight">Test drives needing follow-up</h2>
          </header>
          <ul className="grid gap-3 sm:grid-cols-2">
            {reminderCandidates.map((conv) => {
              const buyerLine = conv.last_message_body
                ? conv.last_message_body.replace(/\s+/g, " ").slice(0, 200)
                : "(no recent buyer message)";
              const smsAvailable = sms && Boolean(dealer.sms_number) && Boolean(conv.buyer_phone);
              return (
                <li key={conv.id}>
                  <ReminderTile
                    conversationId={conv.id}
                    buyerLine={buyerLine}
                    smsAvailable={smsAvailable}
                  />
                </li>
              );
            })}
          </ul>
        </section>
      ) : null}

      <section className="grid gap-3">
        <header className="flex items-center justify-between">
          <h2 className="text-lg font-semibold tracking-tight">Recent conversations</h2>
          <Link
            href="/dashboard/inbox"
            className="text-xs font-medium text-zinc-500 hover:text-zinc-900"
          >
            View all
          </Link>
        </header>

        {conversations.length === 0 ? (
          <EmptyInbox publicUrl={publicUrl} />
        ) : (
          <ul className="grid gap-2">
            {conversations.map((conv) => (
              <li key={conv.id}>
                <ConversationCard conv={conv} />
              </li>
            ))}
          </ul>
        )}
      </section>
    </div>
  );
}

function HotBanner({ rows }: { rows: ConversationWithLatestRow[] }) {
  return (
    <div className="rounded-xl border border-amber-300 bg-amber-50 p-4">
      <div className="flex items-center justify-between">
        <h2 className="text-sm font-semibold text-amber-900">
          {rows.length} hot buyer{rows.length === 1 ? "" : "s"} ready to close
        </h2>
        <Link
          href="/dashboard/inbox"
          className="text-xs font-semibold text-amber-900 underline hover:text-amber-950"
        >
          View
        </Link>
      </div>
      <ul className="mt-2 grid gap-1 text-xs text-zinc-800">
        {rows.slice(0, 3).map((conv) => (
          <li key={conv.id} className="line-clamp-1">
            <Link href={`/dashboard/inbox/${conv.id}`} className="hover:underline">
              {conv.last_message_body
                ? conv.last_message_body.replace(/\s+/g, " ").slice(0, 200)
                : "(no preview)"}
            </Link>
          </li>
        ))}
      </ul>
    </div>
  );
}

function EmptyInbox({ publicUrl }: { publicUrl: string }) {
  return (
    <div className="rounded-xl border border-dashed border-zinc-300 bg-white p-8 text-center text-sm text-zinc-600">
      <p className="font-medium text-zinc-900">No conversations yet.</p>
      <p className="mt-2">
        Share your buyer link in your Marketplace listings, your website, and your text replies:
      </p>
      <p className="mt-2 break-all font-mono text-xs text-zinc-700">{publicUrl}</p>
    </div>
  );
}

function ConversationCard({ conv }: { conv: ConversationWithLatestRow }) {
  return (
    <Link
      href={`/dashboard/inbox/${conv.id}`}
      className="flex flex-col gap-1 rounded-xl border border-zinc-200 bg-white p-4 transition hover:border-zinc-400"
    >
      <div className="flex items-center justify-between text-xs text-zinc-500">
        <span className="inline-flex items-center gap-2">
          <span
            className={
              conv.status === "open"
                ? "inline-block h-1.5 w-1.5 rounded-full bg-emerald-500"
                : "inline-block h-1.5 w-1.5 rounded-full bg-zinc-300"
            }
            aria-hidden
          />
          {conv.status === "open" ? "Open" : "Closed"} ·{" "}
          {conv.language === "es" ? "Español" : "English"}
          {" · "}
          {conv.lead_status}
          {conv.last_intent ? ` · ${conv.last_intent.replace("_", " ")}` : ""}
          {conv.pending_count > 0 ? (
            <span className="ml-1 inline-flex items-center rounded-full bg-amber-100 px-2 py-0.5 text-[10px] font-semibold text-amber-800">
              {conv.pending_count} pending
            </span>
          ) : null}
        </span>
        <time dateTime={conv.updated_at}>{formatTimestamp(conv.updated_at)}</time>
      </div>
      <p className="line-clamp-2 text-sm text-zinc-900">
        {conv.last_message_body
          ? `${rolePrefix(conv.last_message_role)}${conv.last_message_body.replace(/\s+/g, " ").slice(0, 200)}`
          : "(no messages yet)"}
      </p>
    </Link>
  );
}

function rolePrefix(role: string | null): string {
  if (role === "buyer") return "Buyer: ";
  if (role === "ai") return "AI: ";
  if (role === "dealer") return "Team: ";
  return "";
}

function formatTimestamp(ts: string): string {
  const d = new Date(ts);
  if (Number.isNaN(d.getTime())) return "";
  return d.toLocaleString(undefined, {
    month: "short",
    day: "numeric",
    hour: "numeric",
    minute: "2-digit",
  });
}

async function loadReminderCandidates(
  sb: Awaited<ReturnType<typeof createServerSupabase>>,
  dealerId: string,
): Promise<ConversationWithLatestRow[]> {
  const sinceDay = new Date(new Date().getTime() - 24 * 60 * 60 * 1000).toISOString();
  const { data } = await sb
    .from("conversations_with_latest")
    .select("*")
    .eq("dealer_id", dealerId)
    .eq("last_intent", "test_drive")
    .eq("lead_status", "booked")
    .gt("updated_at", sinceDay)
    .order("updated_at", { ascending: false })
    .limit(10);

  const candidates = (data ?? []) as ConversationWithLatestRow[];
  if (candidates.length === 0) return [];

  // Filter out conversations with a recent dealer/auto/approved AI reply
  // in the last 4h. Per-row count keeps the SQL simple.
  const fourHoursAgo = new Date(new Date().getTime() - 4 * 60 * 60 * 1000).toISOString();
  const filtered: ConversationWithLatestRow[] = [];
  for (const conv of candidates) {
    const recentRes = await sb
      .from("messages")
      .select("id", { count: "exact", head: true })
      .eq("conversation_id", conv.id)
      .gt("created_at", fourHoursAgo)
      .or("role.eq.dealer,and(role.eq.ai,approval_status.in.(approved,auto,sent))");
    const recentCount = recentRes.count ?? 0;
    if (recentCount === 0) filtered.push(conv);
  }
  return filtered;
}
