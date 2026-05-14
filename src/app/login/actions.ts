"use server";

import { headers } from "next/headers";
import { createServerSupabase } from "@/lib/supabase-server";
import { supabaseAuthConfigured } from "@/lib/env";

export type LoginState =
  | { status: "idle" }
  | { status: "ok"; email: string }
  | { status: "error"; message: string };

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

function originFrom(host: string | null, proto: string | null): string {
  const explicit = process.env.NEXT_PUBLIC_SITE_URL?.trim();
  if (explicit) return explicit.replace(/\/$/, "");
  if (host) {
    const scheme = proto?.split(",")[0]?.trim() || (host.startsWith("localhost") ? "http" : "https");
    return `${scheme}://${host}`;
  }
  return "http://localhost:3000";
}

export async function requestMagicLink(
  _prev: LoginState,
  formData: FormData,
): Promise<LoginState> {
  const raw = formData.get("email");
  const email = (typeof raw === "string" ? raw : "").trim().toLowerCase();
  if (!EMAIL_RE.test(email) || email.length > 254) {
    return { status: "error", message: "Enter a valid email address." };
  }

  if (!supabaseAuthConfigured) {
    return {
      status: "error",
      message:
        "Auth is not configured on this server. Add NEXT_PUBLIC_SUPABASE_URL and NEXT_PUBLIC_SUPABASE_ANON_KEY to .env.local.",
    };
  }

  const h = await headers();
  const origin = originFrom(h.get("host"), h.get("x-forwarded-proto"));

  const sb = await createServerSupabase();
  const { error } = await sb.auth.signInWithOtp({
    email,
    options: {
      emailRedirectTo: `${origin}/auth/callback`,
      shouldCreateUser: true,
    },
  });

  if (error) {
    return { status: "error", message: "Could not send the magic link. Try again in a moment." };
  }
  return { status: "ok", email };
}
