// Helpers used by every server component / action under /dashboard. Encodes
// two rules:
//   1. You must be signed in.
//   2. You must have a `dealers` row — otherwise we send you to onboarding.

import { redirect } from "next/navigation";
import { createServerSupabase } from "./supabase-server";
import type { DealerRow } from "./db-types";
import type { User } from "@supabase/supabase-js";

export async function getOptionalUser(): Promise<User | null> {
  const sb = await createServerSupabase();
  const { data, error } = await sb.auth.getUser();
  if (error) return null;
  return data.user ?? null;
}

export interface DealerContext {
  user: User;
  dealer: DealerRow;
}

export interface MaybeDealerContext {
  user: User;
  dealer: DealerRow | null;
}

export async function requireUser(): Promise<{ user: User }> {
  const user = await getOptionalUser();
  if (!user) {
    redirect("/login");
  }
  return { user };
}

export async function getDealerForUser(userId: string): Promise<DealerRow | null> {
  const sb = await createServerSupabase();
  const { data, error } = await sb
    .from("dealers")
    .select("*")
    .eq("owner_user_id", userId)
    .maybeSingle();
  if (error || !data) return null;
  return data;
}

// Use inside dashboard pages that need the dealer context. Redirects to
// /login if signed out, /dashboard/onboarding if no dealer row exists.
export async function requireDealer(): Promise<DealerContext> {
  const { user } = await requireUser();
  const dealer = await getDealerForUser(user.id);
  if (!dealer) {
    redirect("/dashboard/onboarding");
  }
  return { user, dealer };
}

// Use inside the onboarding flow itself, where the dealer row may legitimately
// not exist yet.
export async function requireUserMaybeDealer(): Promise<MaybeDealerContext> {
  const { user } = await requireUser();
  const dealer = await getDealerForUser(user.id);
  return { user, dealer };
}
