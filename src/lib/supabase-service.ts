// Service-role Supabase client. SERVER-ONLY. Bypasses RLS, so every caller
// must filter by dealer_id explicitly. Used by:
//   - /api/chat (writes buyer + ai messages without an auth session)
//   - CSV bulk inventory upload action
//   - the public chat widget's SSR shell to load existing transcript
//
// Never import from a "use client" component.

import { createClient, type SupabaseClient } from "@supabase/supabase-js";
import { requireServiceEnv } from "./env";

let cached: SupabaseClient | null = null;

export function createServiceSupabase(): SupabaseClient {
  if (cached) return cached;
  const { url, serviceKey } = requireServiceEnv();
  cached = createClient(url, serviceKey, {
    auth: {
      persistSession: false,
      autoRefreshToken: false,
      detectSessionInUrl: false,
    },
  });
  return cached;
}
