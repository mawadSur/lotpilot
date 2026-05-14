// Public buyer chat widget. SSR shell loads dealer + transcript (if cookie
// already exists) and hands them to the client component. No dealer auth.

export const dynamic = "force-dynamic";

import Link from "next/link";
import { notFound } from "next/navigation";
import type { Metadata } from "next";
import { ChatWidget } from "./chat-widget";
import { createServiceSupabase } from "@/lib/supabase-service";
import { readBuyerSession } from "@/lib/session";
import { supabaseServiceConfigured } from "@/lib/env";
import { webWidgetConsentText } from "@/lib/consent";
import type { ConversationRow, DealerRow, MessageRow } from "@/lib/db-types";

interface PageProps {
  params: Promise<{ slug: string }>;
}

export async function generateMetadata({ params }: PageProps): Promise<Metadata> {
  const { slug } = await params;
  return {
    title: `Chat — ${slug}`,
    description: "Chat with the dealer about a vehicle you saw.",
    robots: { index: false, follow: false },
  };
}

export default async function PublicChatPage({ params }: PageProps) {
  const { slug } = await params;

  if (!supabaseServiceConfigured) {
    return (
      <main className="min-h-dvh bg-zinc-50 text-zinc-900">
        <div className="mx-auto max-w-md px-6 py-16 text-center">
          <h1 className="text-2xl font-semibold">Chat unavailable</h1>
          <p className="mt-3 text-sm text-zinc-600">
            This site is not fully configured yet. Please reach out to the dealer directly.
          </p>
        </div>
      </main>
    );
  }

  const sb = createServiceSupabase();
  const dealerRes = await sb
    .from("dealers")
    .select("id,slug,name,signature,calendly_url,timezone,business_hours")
    .eq("slug", slug.toLowerCase())
    .maybeSingle();

  const dealer = dealerRes.data as Pick<
    DealerRow,
    "id" | "slug" | "name" | "signature" | "calendly_url" | "timezone" | "business_hours"
  > | null;

  if (!dealer) {
    notFound();
  }

  const session = await readBuyerSession();
  let initialMessages: Pick<MessageRow, "id" | "role" | "body" | "created_at">[] = [];
  let conversationId: string | null = null;

  if (session) {
    const convRes = await sb
      .from("conversations")
      .select("id")
      .eq("dealer_id", dealer.id)
      .eq("buyer_session", session)
      .maybeSingle();
    const conv = convRes.data as Pick<ConversationRow, "id"> | null;
    if (conv) {
      conversationId = conv.id;
      const msgRes = await sb
        .from("messages")
        .select("id,role,body,created_at,approval_status")
        .eq("conversation_id", conv.id)
        .order("created_at", { ascending: true })
        .limit(40);
      // Filter out pending / rejected AI drafts before they reach the
      // buyer (defence in depth — RLS would also block on a direct read).
      initialMessages = ((msgRes.data ?? []) as (Pick<
        MessageRow,
        "id" | "role" | "body" | "created_at"
      > & { approval_status: string | null })[])
        .filter(
          (m) =>
            m.role === "buyer" ||
            m.approval_status === "approved" ||
            m.approval_status === "auto" ||
            m.approval_status === "sent",
        )
        .map(({ id, role, body, created_at }) => ({ id, role, body, created_at }));
    }
  }

  const consentText = webWidgetConsentText(dealer.name);

  return (
    <main className="min-h-dvh bg-zinc-50 text-zinc-900">
      <div className="mx-auto flex min-h-dvh max-w-md flex-col px-4 py-6 sm:py-8">
        <header className="flex items-center justify-between border-b border-zinc-200 pb-4">
          <div>
            <p className="text-xs uppercase tracking-widest text-zinc-500">Chat with</p>
            <h1 className="text-xl font-semibold tracking-tight">{dealer.name}</h1>
          </div>
          <span className="inline-flex h-2.5 w-2.5 rounded-full bg-emerald-500" aria-hidden />
        </header>

        <ChatWidget
          slug={dealer.slug}
          dealerName={dealer.name}
          consentText={consentText}
          conversationId={conversationId}
          initialMessages={initialMessages}
        />

        <footer className="mt-6 space-y-2 text-center text-[11px] leading-relaxed text-zinc-500">
          <p>
            By chatting, you agree that {dealer.name} and LotPilot may
            store your messages to reply and follow up. Replies are
            AI-generated and may be reviewed by the dealer. We don&apos;t
            sell your information.
          </p>
          <p>
            <Link href="/privacy" className="underline hover:text-zinc-700">
              Privacy
            </Link>
          </p>
        </footer>
      </div>
    </main>
  );
}
