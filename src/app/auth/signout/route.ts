import { NextResponse, type NextRequest } from "next/server";
import { createServerSupabase } from "@/lib/supabase-server";
import { supabaseAuthConfigured } from "@/lib/env";

export async function POST(request: NextRequest) {
  if (supabaseAuthConfigured) {
    const sb = await createServerSupabase();
    await sb.auth.signOut();
  }
  return NextResponse.redirect(new URL("/login", request.url));
}
