// Magic-link landing route. Supabase redirects the dealer here with a
// short-lived `code` query param, which we exchange for a session.

import { NextResponse, type NextRequest } from "next/server";
import { createServerSupabase } from "@/lib/supabase-server";
import { supabaseAuthConfigured } from "@/lib/env";

export async function GET(request: NextRequest) {
  const { searchParams, origin } = new URL(request.url);
  const code = searchParams.get("code");
  const next = searchParams.get("next") || "/dashboard";

  if (!code) {
    return NextResponse.redirect(`${origin}/login?error=missing_code`);
  }
  if (!supabaseAuthConfigured) {
    return NextResponse.redirect(`${origin}/login?error=auth_not_configured`);
  }

  const sb = await createServerSupabase();
  const { error } = await sb.auth.exchangeCodeForSession(code);
  if (error) {
    return NextResponse.redirect(`${origin}/login?error=exchange_failed`);
  }

  // Only allow same-origin relative paths in `next`.
  const safeNext = next.startsWith("/") && !next.startsWith("//") ? next : "/dashboard";
  return NextResponse.redirect(`${origin}${safeNext}`);
}
