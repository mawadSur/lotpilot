// Server-side Supabase client (RLS-aware). Use inside server components,
// server actions, and route handlers that should respect the dealer's
// session. Cookie writes that happen during a Server Component render are
// silently swallowed — middleware handles refreshes.

import { createServerClient } from "@supabase/ssr";
import { cookies } from "next/headers";
import { requireAuthEnv } from "./env";

// We deliberately do not pass a typed Database generic here. The Supabase
// type machinery in v2.105 is fragile when fed hand-written types, so we
// keep the runtime client untyped and apply our row types via explicit
// `as` assertions at the call site (which we do everywhere anyway, since
// query results pass through `data ?? []` first).

export async function createServerSupabase() {
  const { url, anonKey } = requireAuthEnv();
  const cookieStore = await cookies();
  return createServerClient(url, anonKey, {
    cookies: {
      getAll() {
        return cookieStore.getAll().map((c) => ({ name: c.name, value: c.value }));
      },
      setAll(cookiesToSet) {
        try {
          for (const { name, value, options } of cookiesToSet) {
            cookieStore.set(name, value, options);
          }
        } catch {
          // Server Components: writes are not allowed. Middleware will
          // refresh on the next navigation.
        }
      },
    },
  });
}
