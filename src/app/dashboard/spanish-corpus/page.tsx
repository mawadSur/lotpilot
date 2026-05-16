// /dashboard/spanish-corpus — dealer-curated EN/ES phrasing library.
//
// The pipeline pulls the top 5 non-archived rows (`dealer_id = mine`)
// when a buyer writes in Spanish, and inlines them into the system
// prompt as founder-voice examples (see src/lib/ai.ts + chat-pipeline).
// This page is the dealer-facing manager: list + add. Archiving and
// editing arrive in v0.7.2.
//
// Auth: uses the RLS-scoped server client (NOT service-role). RLS
// already restricts what each dealer sees and inserts.

import { requireDealer } from "@/lib/auth";
import { createServerSupabase } from "@/lib/supabase-server";
import type { SpanishPhraseRow } from "@/lib/db-types";
import { AddPhraseForm } from "./add-form";

export const dynamic = "force-dynamic";

export default async function SpanishCorpusPage() {
  const { dealer } = await requireDealer();
  const sb = await createServerSupabase();

  // RLS: select returns this dealer's rows + globals (dealer_id IS NULL).
  // We surface BOTH so dealers know what's in play; only their own are
  // editable in later versions.
  const { data } = await sb
    .from("spanish_phrases")
    .select("*")
    .order("created_at", { ascending: false })
    .limit(100);

  const rows = (data ?? []) as SpanishPhraseRow[];
  const active = rows.filter((r) => r.archived_at == null);

  return (
    <div className="grid gap-6">
      <header className="grid gap-1">
        <h1 className="text-xl font-semibold tracking-tight">Spanish corpus</h1>
        <p className="text-sm text-zinc-600">
          Founder-voice EN/ES phrasing examples. When a buyer writes in
          Spanish, your top 5 most-recent non-archived phrases are
          inlined into the AI&rsquo;s system prompt so it copies your
          register and warmth.
        </p>
      </header>

      <AddPhraseForm />

      <section className="grid gap-3">
        <h2 className="text-sm font-semibold">
          Phrases ({active.length} active{rows.length !== active.length ? `, ${rows.length - active.length} archived` : ""})
        </h2>

        {active.length === 0 ? (
          <p className="rounded-xl border border-dashed border-zinc-300 bg-white p-8 text-center text-sm text-zinc-600">
            No phrases yet. Add a few above — start with how you greet a Spanish-speaking buyer.
          </p>
        ) : (
          <ul className="grid gap-2">
            {active.map((p) => {
              const isGlobal = p.dealer_id == null;
              const isMine = p.dealer_id === dealer.id;
              return (
                <li
                  key={p.id}
                  className="grid gap-1 rounded-xl border border-zinc-200 bg-white p-3"
                >
                  <div className="flex flex-wrap items-center gap-2 text-[10px] uppercase tracking-wide">
                    <span className="rounded bg-zinc-900 px-1.5 py-0.5 font-semibold text-white">
                      {p.intent}
                    </span>
                    {p.situation_tag ? (
                      <span className="rounded bg-zinc-100 px-1.5 py-0.5 text-zinc-700">
                        {p.situation_tag}
                      </span>
                    ) : null}
                    {isGlobal ? (
                      <span className="rounded bg-amber-100 px-1.5 py-0.5 text-amber-900">
                        global (founder-seeded)
                      </span>
                    ) : null}
                    {isMine ? (
                      <span className="rounded bg-emerald-100 px-1.5 py-0.5 text-emerald-900">
                        yours
                      </span>
                    ) : null}
                  </div>
                  <p className="text-sm text-zinc-900">
                    <span className="font-semibold text-zinc-500">EN:</span> {p.en_text}
                  </p>
                  <p className="text-sm text-zinc-900">
                    <span className="font-semibold text-zinc-500">ES:</span> {p.es_text}
                  </p>
                  <time
                    className="text-[10px] uppercase tracking-wide text-zinc-500"
                    dateTime={p.created_at}
                  >
                    {new Date(p.created_at).toLocaleString()}
                  </time>
                </li>
              );
            })}
          </ul>
        )}
      </section>
    </div>
  );
}
