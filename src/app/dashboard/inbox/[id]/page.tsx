// Conversation detail. v0.2 adds:
//   - lead-status dropdown
//   - private notes field (debounced auto-save)
//   - approve/edit/reject buttons on pending AI drafts
//   - rejected drafts shown muted + struck through with approver/time
//   - approved + auto + sent rendered the same as v0.1's bubbles

import Link from "next/link";
import { notFound } from "next/navigation";
import { requireDealer } from "@/lib/auth";
import { createServerSupabase } from "@/lib/supabase-server";
import type { ConversationRow, MessageRow } from "@/lib/db-types";
import { StatusDropdown } from "../status-dropdown";
import { NotesField } from "../notes-field";
import { MessageActions } from "./message-actions";

interface PageProps {
  params: Promise<{ id: string }>;
}

export default async function ConversationDetail({ params }: PageProps) {
  const { id } = await params;
  const { dealer } = await requireDealer();
  const sb = await createServerSupabase();

  const convRes = await sb
    .from("conversations")
    .select("*")
    .eq("id", id)
    .eq("dealer_id", dealer.id)
    .maybeSingle();

  const conversation = convRes.data as ConversationRow | null;
  if (!conversation) notFound();

  const msgRes = await sb
    .from("messages")
    .select("*")
    .eq("conversation_id", conversation.id)
    .order("created_at", { ascending: true })
    .limit(500);

  const messages = (msgRes.data ?? []) as MessageRow[];

  return (
    <div className="grid gap-4">
      <header className="flex flex-col gap-3 rounded-xl border border-zinc-200 bg-white p-4 sm:flex-row sm:items-start sm:justify-between">
        <div>
          <Link
            href="/dashboard/inbox"
            className="text-xs font-medium text-zinc-500 hover:text-zinc-900"
          >
            ← Back to inbox
          </Link>
          <h1 className="mt-1 text-xl font-semibold tracking-tight">Conversation</h1>
          <p className="text-xs text-zinc-500">
            Started {new Date(conversation.created_at).toLocaleString()}
            {" · "}
            {conversation.language === "es" ? "Español" : "English"}
            {" · "}channel {conversation.channel}
            {conversation.last_intent ? ` · intent: ${conversation.last_intent.replace("_", " ")}` : ""}
            {conversation.suppressed_at ? " · opted out" : ""}
          </p>
        </div>
        <div className="flex items-center gap-2">
          <span className="text-xs font-semibold uppercase tracking-wide text-zinc-500">
            Status
          </span>
          <StatusDropdown conversationId={conversation.id} initialStatus={conversation.lead_status} />
        </div>
      </header>

      <section className="rounded-xl border border-zinc-200 bg-white p-4">
        <NotesField conversationId={conversation.id} initialNotes={conversation.notes ?? ""} />
      </section>

      {messages.length === 0 ? (
        <p className="rounded-xl border border-dashed border-zinc-300 bg-white p-6 text-center text-sm text-zinc-600">
          No messages yet.
        </p>
      ) : (
        <ol className="grid gap-3">
          {messages.map((m) => (
            <li key={m.id}>
              <MessageBubble message={m} />
            </li>
          ))}
        </ol>
      )}

      <p className="rounded-md bg-zinc-100 px-3 py-2 text-xs text-zinc-600">
        Direct typed replies from the dashboard ship in v0.3. For now,
        approve / edit / reject AI drafts above and use SMS or phone for
        ad-hoc follow-ups.
      </p>
    </div>
  );
}

function MessageBubble({ message }: { message: MessageRow }) {
  const isBuyer = message.role === "buyer";
  const isAi = message.role === "ai";
  const isPending = isAi && message.approval_status === "pending";
  const isRejected = isAi && message.approval_status === "rejected";

  const bubbleClass = isBuyer
    ? "max-w-[80%] rounded-2xl rounded-bl-sm bg-white px-3 py-2 text-sm text-zinc-900 ring-1 ring-zinc-200"
    : isAi
      ? isPending
        ? "max-w-[80%] rounded-2xl rounded-br-sm bg-amber-50 px-3 py-2 text-sm text-zinc-900 ring-2 ring-amber-300"
        : isRejected
          ? "max-w-[80%] rounded-2xl rounded-br-sm bg-zinc-100 px-3 py-2 text-sm text-zinc-500 line-through ring-1 ring-zinc-200"
          : "max-w-[80%] rounded-2xl rounded-br-sm bg-amber-50 px-3 py-2 text-sm text-zinc-900 ring-1 ring-amber-200"
      : "max-w-[80%] rounded-2xl rounded-br-sm bg-zinc-900 px-3 py-2 text-sm text-white";

  return (
    <div className={`flex ${isBuyer ? "justify-start" : "justify-end"}`}>
      <div className={bubbleClass}>
        <p className="whitespace-pre-wrap">{message.body}</p>
        <div className="mt-1 flex flex-wrap items-center gap-2 text-[10px] text-zinc-500">
          <span>
            {message.role === "ai" ? "AI" : message.role === "buyer" ? "Buyer" : "Team"}
            {" · "}
            {new Date(message.created_at).toLocaleString(undefined, {
              month: "short",
              day: "numeric",
              hour: "numeric",
              minute: "2-digit",
            })}
          </span>
          {isAi ? <ApprovalBadge status={message.approval_status} approvedAt={message.approved_at} /> : null}
        </div>
        {isPending ? <MessageActions messageId={message.id} body={message.body} /> : null}
      </div>
    </div>
  );
}

function ApprovalBadge({
  status,
  approvedAt,
}: {
  status: MessageRow["approval_status"];
  approvedAt: string | null;
}) {
  if (status === "auto") return null;
  if (status === "pending") {
    return (
      <span className="rounded-full bg-amber-100 px-2 py-0.5 font-semibold text-amber-800">
        pending review
      </span>
    );
  }
  if (status === "rejected") {
    return (
      <span className="text-rose-600">
        rejected{approvedAt ? ` at ${new Date(approvedAt).toLocaleTimeString()}` : ""}
      </span>
    );
  }
  if (status === "approved") {
    return <span className="text-emerald-700">approved</span>;
  }
  if (status === "sent") {
    return <span className="text-emerald-700">sent</span>;
  }
  return null;
}
