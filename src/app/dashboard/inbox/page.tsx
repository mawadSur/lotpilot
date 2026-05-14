// Inbox list. Uses the conversations_with_latest view to dodge the
// v0.1 N+1, surfaces lead-status filter chips, and lets the dealer
// move a conversation through the pipeline inline.

import Link from "next/link";
import { requireDealer } from "@/lib/auth";
import { createServerSupabase } from "@/lib/supabase-server";
import type { ConversationWithLatestRow, LeadStatus } from "@/lib/db-types";
import { StatusDropdown } from "./status-dropdown";

interface PageProps {
  searchParams: Promise<{ status?: string }>;
}

const FILTER_OPTIONS: { value: LeadStatus | "all"; label: string }[] = [
  { value: "all", label: "All" },
  { value: "new", label: "New" },
  { value: "qualified", label: "Qualified" },
  { value: "booked", label: "Booked" },
  { value: "sold", label: "Sold" },
  { value: "lost", label: "Lost" },
];

const VALID_STATUSES = new Set<LeadStatus>(["new", "qualified", "booked", "sold", "lost"]);

export default async function InboxPage({ searchParams }: PageProps) {
  const { dealer } = await requireDealer();
  const sp = await searchParams;
  const filter: LeadStatus | "all" =
    sp.status && VALID_STATUSES.has(sp.status as LeadStatus) ? (sp.status as LeadStatus) : "all";

  const sb = await createServerSupabase();
  let query = sb
    .from("conversations_with_latest")
    .select("*")
    .eq("dealer_id", dealer.id)
    .order("updated_at", { ascending: false })
    .limit(200);

  if (filter !== "all") {
    query = query.eq("lead_status", filter);
  }

  const { data } = await query;
  const conversations = (data ?? []) as ConversationWithLatestRow[];

  return (
    <div className="grid gap-4">
      <header className="flex items-center justify-between">
        <h1 className="text-xl font-semibold tracking-tight">Inbox</h1>
        <p className="text-xs text-zinc-500">
          {conversations.length} conversation{conversations.length === 1 ? "" : "s"}
          {filter !== "all" ? ` · ${filter}` : ""}
        </p>
      </header>

      <nav aria-label="Filter by lead status" className="flex flex-wrap gap-1">
        {FILTER_OPTIONS.map((opt) => {
          const active = filter === opt.value;
          const href = opt.value === "all" ? "/dashboard/inbox" : `/dashboard/inbox?status=${opt.value}`;
          return (
            <Link
              key={opt.value}
              href={href}
              className={
                active
                  ? "rounded-md bg-zinc-900 px-3 py-1 text-xs font-semibold text-white"
                  : "rounded-md border border-zinc-300 bg-white px-3 py-1 text-xs font-medium text-zinc-700 hover:bg-zinc-50"
              }
            >
              {opt.label}
            </Link>
          );
        })}
      </nav>

      {conversations.length === 0 ? (
        <p className="rounded-xl border border-dashed border-zinc-300 bg-white p-8 text-center text-sm text-zinc-600">
          No conversations yet. Share your buyer link <code className="font-mono">/c/{dealer.slug}</code>.
        </p>
      ) : (
        <ul className="grid gap-2">
          {conversations.map((conv) => (
            <li key={conv.id}>
              <ConversationCard conv={conv} />
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}

function ConversationCard({ conv }: { conv: ConversationWithLatestRow }) {
  const ts = conv.last_message_at ?? conv.updated_at;
  const previewBody = conv.last_message_body
    ? `${rolePrefix(conv.last_message_role)}${conv.last_message_body.replace(/\s+/g, " ").slice(0, 200)}`
    : "(no messages yet)";
  return (
    <div className="flex flex-col gap-2 rounded-xl border border-zinc-200 bg-white p-4 transition hover:border-zinc-400 sm:flex-row sm:items-start sm:justify-between">
      <Link href={`/dashboard/inbox/${conv.id}`} className="grid flex-1 gap-1">
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
            {conv.language === "es" ? "Español" : "English"}
            {conv.last_intent ? ` · ${conv.last_intent.replace("_", " ")}` : ""}
            {conv.pending_count > 0 ? (
              <span className="ml-1 inline-flex items-center rounded-full bg-amber-100 px-2 py-0.5 text-[10px] font-semibold text-amber-800">
                {conv.pending_count} pending
              </span>
            ) : null}
          </span>
          <time dateTime={ts}>{formatTimestamp(ts)}</time>
        </div>
        <p className="line-clamp-2 text-sm text-zinc-900">{previewBody}</p>
      </Link>
      <div className="shrink-0 sm:pl-3">
        <StatusDropdown conversationId={conv.id} initialStatus={conv.lead_status} compact />
      </div>
    </div>
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
