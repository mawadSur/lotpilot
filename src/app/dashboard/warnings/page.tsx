// /dashboard/warnings — operator triage list. Shows every unresolved
// system_warnings row for the dealer, with a dismiss button per row.
// Resolved rows drop out (we deliberately don't delete — the audit
// trail stays intact, just hidden).

import { requireDealer } from "@/lib/auth";
import { createServerSupabase } from "@/lib/supabase-server";
import type { SystemWarningRow } from "@/lib/db-types";
import { DismissButton } from "./dismiss-button";

export const dynamic = "force-dynamic";

const KIND_COPY: Record<SystemWarningRow["kind"], { title: string; hint: string }> = {
  calendly_no_match: {
    title: "Calendly booking landed without a matching thread",
    hint: "The buyer booked a test drive, but we couldn't pin it to one of your inbox threads. Check your Calendly form fields (email + phone) line up with how buyers contact you.",
  },
  calendly_api_ambiguous: {
    title: "Multiple dealers share your Calendly slug",
    hint: "Calendly API returned a slug that matches more than one dealer in LotPilot. Make your Calendly URL unique (e.g. add the dealership name).",
  },
  whatsapp_auth_failed: {
    title: "WhatsApp send failed: token rejected by Meta",
    hint: "Your WhatsApp Cloud API access token expired or was revoked. Re-issue a system-user token and update WHATSAPP_ACCESS_TOKEN.",
  },
  whatsapp_window_closed: {
    title: "WhatsApp 24h window closed and template failed",
    hint: "Meta only allows free-form replies within 24h of the buyer's last message. Your fallback template either isn't approved or doesn't exist. Reach out to support if this repeats.",
  },
  marketplace_secret_disclosed: {
    title: "Marketplace extension secret was viewed",
    hint: "Someone with dashboard access viewed your extension secret. If that wasn't you, rotate by asking support to roll the master secret.",
  },
  marketplace_secret_rotated: {
    title: "Marketplace extension is signing under the previous master",
    hint: "We rolled the LotPilot master secret and your extension is still authenticating against the old one. Visit the marketplace settings to re-issue your dealer secret and update the extension before the prev-master grace window closes.",
  },
};

export default async function WarningsPage() {
  const { dealer } = await requireDealer();
  const sb = await createServerSupabase();
  const { data } = await sb
    .from("system_warnings")
    .select("*")
    .eq("dealer_id", dealer.id)
    .is("resolved_at", null)
    .order("created_at", { ascending: false })
    .limit(100);

  const rows = (data ?? []) as SystemWarningRow[];

  return (
    <div className="grid gap-4">
      <header>
        <h1 className="text-xl font-semibold tracking-tight">System warnings</h1>
        <p className="text-sm text-zinc-600">
          Things LotPilot tried to do for you but couldn&rsquo;t. Dismiss to
          remove from the banner; the audit trail is preserved.
        </p>
      </header>

      {rows.length === 0 ? (
        <p className="rounded-xl border border-dashed border-zinc-300 bg-white p-8 text-center text-sm text-zinc-600">
          No open warnings.
        </p>
      ) : (
        <ul className="grid gap-3">
          {rows.map((w) => {
            const copy = KIND_COPY[w.kind];
            return (
              <li
                key={w.id}
                className="grid gap-2 rounded-xl border border-amber-200 bg-amber-50 p-4 sm:flex sm:items-start sm:justify-between"
              >
                <div className="grid gap-1">
                  <h2 className="text-sm font-semibold text-amber-900">{copy.title}</h2>
                  <p className="text-xs text-zinc-700">{copy.hint}</p>
                  <time className="text-[10px] uppercase tracking-wide text-zinc-500" dateTime={w.created_at}>
                    {new Date(w.created_at).toLocaleString()}
                  </time>
                </div>
                <DismissButton id={w.id} />
              </li>
            );
          })}
        </ul>
      )}
    </div>
  );
}
