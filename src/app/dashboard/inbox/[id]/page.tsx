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
import { smsEnabled } from "@/lib/env";
import type { ConversationRow, LeadShareRow, MessageRow } from "@/lib/db-types";
import { StatusDropdown } from "../status-dropdown";
import { NotesField } from "../notes-field";
import { MessageActions } from "./message-actions";
import { ShareLead } from "./share-lead";

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

  // T4.2: existing lead-share rows for this conversation. Source-side
  // (we initiated) or target-side (we received) — RLS already scopes
  // to dealer, so the union just sorts both. The most-recent row
  // drives the UI: an open consent_sent row means "share button is
  // locked, awaiting buyer reply"; an accepted row means "forked to X"
  // with a deep link to the forked conversation.
  const sharesRes = await sb
    .from("lead_shares")
    .select("*")
    .or(
      `source_conversation_id.eq.${conversation.id},forked_conversation_id.eq.${conversation.id}`,
    )
    .order("created_at", { ascending: false })
    .limit(10);
  const shares = (sharesRes.data ?? []) as LeadShareRow[];

  // We are the SOURCE for any share whose source_conversation_id ===
  // this conversation; otherwise we're the TARGET (the conversation we
  // see is the fork). Used to pick which sidebar widget renders.
  const sourceShares = shares.filter((s) => s.source_conversation_id === conversation.id);
  const incomingShare = shares.find((s) => s.forked_conversation_id === conversation.id) ?? null;
  const openSourceShare = sourceShares.find(
    (s) => s.status === "pending" || s.status === "consent_sent",
  ) ?? null;

  // Compute the share-button disable reason once, server-side, so the
  // client component doesn't need any state machinery to render it.
  // Matches the gate set in src/lib/lead-share/initiate.ts.
  const shareDisabledReason: string | null = (() => {
    if (incomingShare) return "This conversation is itself a referral.";
    if (openSourceShare) return "A share is already pending consent.";
    if (conversation.channel !== "sms") return "Lead sharing is SMS-only in this release.";
    if (!smsEnabled() || !dealer.sms_number) return "SMS isn't configured for your account.";
    if (!conversation.buyer_phone) return "No buyer phone on file.";
    if (conversation.suppressed_at) return "Buyer opted out — can't message.";
    return null;
  })();

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

      {incomingShare ? (
        <section className="rounded-xl border border-emerald-200 bg-emerald-50 p-4 text-sm text-emerald-900">
          <p className="font-semibold">Referred lead</p>
          <p className="mt-1 text-xs">
            This conversation was forked from another dealer&apos;s thread.
            The buyer consented to the referral via SMS on{" "}
            {incomingShare.accepted_at
              ? new Date(incomingShare.accepted_at).toLocaleString()
              : "(unknown)"}
            . Their consent text is in your <code>consents</code> audit log.
          </p>
        </section>
      ) : (
        <section className="rounded-xl border border-zinc-200 bg-white p-4">
          <p className="text-xs font-semibold uppercase tracking-wide text-zinc-500">
            Lead-share network
          </p>
          <p className="mb-2 mt-1 text-xs text-zinc-600">
            Refer this buyer to another LotPilot dealer. We&apos;ll send a
            TCPA-compliant consent SMS first — no conversation is shared
            without the buyer&apos;s YES.
          </p>
          <ShareLead
            conversationId={conversation.id}
            disabledReason={shareDisabledReason}
          />
          {sourceShares.length > 0 ? (
            <ul className="mt-3 grid gap-1 text-[11px] text-zinc-600">
              {sourceShares.slice(0, 5).map((s) => (
                <li key={s.id}>
                  <ShareStatusLine share={s} />
                </li>
              ))}
            </ul>
          ) : null}
        </section>
      )}

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

function ShareStatusLine({ share }: { share: LeadShareRow }) {
  const labels: Record<LeadShareRow["status"], string> = {
    pending: "Initiating…",
    consent_sent: "Awaiting buyer consent",
    accepted: "Accepted — conversation forked",
    declined: "Buyer declined",
    expired: "Expired (no reply)",
    cancelled: share.cancel_reason
      ? `Cancelled (${share.cancel_reason})`
      : "Cancelled",
  };
  const colour: Record<LeadShareRow["status"], string> = {
    pending: "text-zinc-500",
    consent_sent: "text-amber-700",
    accepted: "text-emerald-700",
    declined: "text-rose-600",
    expired: "text-zinc-500",
    cancelled: "text-zinc-500",
  };
  const when = share.accepted_at ?? share.declined_at ?? share.cancelled_at ?? share.consent_sent_at ?? share.created_at;
  return (
    <span className={colour[share.status]}>
      {labels[share.status]} — {new Date(when).toLocaleString()}
    </span>
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
