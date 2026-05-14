// Dashboard shell + auth guard. Anonymous visitors are redirected to
// /login by the proxy middleware. The "no dealer → /onboarding"
// redirect is enforced per-page (every dashboard page calls
// requireDealer() except /dashboard/onboarding which calls
// requireUserMaybeDealer()) — the layout deliberately avoids that
// branch because Next 16 doesn't expose a reliable server-side
// pathname, and a layout-level redirect would double-fire on the
// onboarding page itself.

export const dynamic = "force-dynamic";

import Link from "next/link";
import type { ReactNode } from "react";
import { requireUserMaybeDealer } from "@/lib/auth";
import { DashboardNav, type NavItem } from "./nav";
import { WarningsBanner } from "./warnings-banner";

const NAV: NavItem[] = [
  { href: "/dashboard", label: "Inbox" },
  { href: "/dashboard/relay", label: "Relay" },
  { href: "/dashboard/inventory", label: "Inventory" },
  { href: "/dashboard/compliance", label: "Compliance" },
  { href: "/dashboard/settings", label: "Settings" },
];

export default async function DashboardLayout({ children }: { children: ReactNode }) {
  // Per-page server components handle the "no dealer → onboarding"
  // redirect (every dashboard page calls requireDealer() except
  // /dashboard/onboarding which calls requireUserMaybeDealer()). The
  // layout only enforces "must be signed in", and renders the chrome.
  const { user, dealer } = await requireUserMaybeDealer();

  return (
    <div className="min-h-dvh bg-zinc-50 text-zinc-900">
      <header className="border-b border-zinc-200 bg-white">
        <div className="mx-auto flex max-w-5xl items-center justify-between px-4 py-3 sm:px-6">
          <Link href="/dashboard" className="flex items-center gap-2">
            <span className="inline-block h-2.5 w-2.5 rounded-full bg-amber-400" aria-hidden />
            <span className="text-sm font-semibold tracking-wide">LotPilot</span>
            {dealer ? (
              <span className="hidden text-xs text-zinc-500 sm:inline">/ {dealer.name}</span>
            ) : null}
          </Link>

          {dealer ? <DashboardNav items={NAV} /> : null}

          <form action="/auth/signout" method="post">
            <button
              type="submit"
              className="text-xs font-medium text-zinc-500 hover:text-zinc-900"
            >
              Sign out{user.email ? ` (${user.email})` : ""}
            </button>
          </form>
        </div>
      </header>

      {dealer ? <WarningsBanner dealerId={dealer.id} /> : null}

      <main className="mx-auto w-full max-w-5xl px-4 py-8 sm:px-6">{children}</main>
    </div>
  );
}
