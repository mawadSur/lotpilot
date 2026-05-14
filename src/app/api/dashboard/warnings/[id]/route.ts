// PATCH /api/dashboard/warnings/[id] — dismiss a system warning.
//
// Auth: Supabase session via requireDealer(). The update goes through
// the authenticated server client so RLS enforces dealer ownership;
// we DO NOT use the service-role client here. A foreign dealer's
// request will see 0 rows updated and we 404 in response.

import { NextResponse, type NextRequest } from "next/server";
import { requireDealer } from "@/lib/auth";
import { createServerSupabase } from "@/lib/supabase-server";
import { log } from "@/lib/log";

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export async function PATCH(
  _request: NextRequest,
  { params }: { params: Promise<{ id: string }> },
) {
  const { dealer } = await requireDealer();
  const { id } = await params;
  if (!UUID_RE.test(id)) {
    return new NextResponse("", { status: 400 });
  }

  const sb = await createServerSupabase();
  // RLS (system_warnings_owner_update) scopes the update to rows the
  // authenticated dealer owns. Returning the affected row gives us a
  // 404-vs-200 signal.
  const res = await sb
    .from("system_warnings")
    .update({ resolved_at: new Date().toISOString() })
    .eq("id", id)
    .eq("dealer_id", dealer.id)
    .is("resolved_at", null)
    .select("id")
    .maybeSingle();

  if (res.error) {
    log.error("warnings.dismiss_failed", {
      dealer_id: dealer.id,
      code: res.error.code,
    });
    return new NextResponse("", { status: 500 });
  }
  if (!res.data) {
    return new NextResponse("", { status: 404 });
  }
  return NextResponse.json({ id });
}
