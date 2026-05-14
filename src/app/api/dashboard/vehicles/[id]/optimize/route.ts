// Listing optimizer endpoint.
//
// POST  /api/dashboard/vehicles/:id/optimize
//   → 200 { variants: ListingSuggestionRow[] }
//   → 403 (RLS)
//   → 404 vehicle not found / not yours
//   → 429 dealer-rate-limited (reuses the chat 'dealer' rule)
//   → 503 budget exhausted / Claude error / DB save error
//
// PATCH /api/dashboard/vehicles/:id/optimize
//   { suggestion_id: string }
//   → 200 marks the picked suggestion as accepted (sets accepted_at).
//   → 404 if the suggestion is not for this vehicle / dealer.
//
// Auth: requireDealer; the per-row dealer scoping on the vehicle and
// suggestion is enforced via the user-session Supabase client (RLS).
// The actual variant batch insert uses the service-role client because
// it writes 3 rows + we want one round-trip.

import { NextResponse, type NextRequest } from "next/server";
import { requireDealer } from "@/lib/auth";
import { createServerSupabase } from "@/lib/supabase-server";
import { createServiceSupabase } from "@/lib/supabase-service";
import { checkRate } from "@/lib/ratelimit";
import {
  assertBudgetAvailable,
  BudgetExceededError,
  estimateCallUsd,
  recordSpend,
} from "@/lib/budget";
import {
  generateListingVariants,
  ListingOptimizerError,
  LISTING_AI_MAX_OUTPUT_TOKENS,
  estimateListingChars,
} from "@/lib/listing-optimizer";
import { log } from "@/lib/log";
import { anthropicConfigured } from "@/lib/env";
import type { ListingSuggestionRow, VehicleRow } from "@/lib/db-types";

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

interface RouteContext {
  params: Promise<{ id: string }>;
}

function bad(status: number, error: string, headers?: Record<string, string>): NextResponse {
  return NextResponse.json({ error }, { status, headers });
}

export async function POST(_request: NextRequest, ctx: RouteContext) {
  const requestId = crypto.randomUUID();
  const startedAt = Date.now();

  const { id } = await ctx.params;
  if (!UUID_RE.test(id)) {
    return bad(400, "Invalid vehicle id.");
  }

  if (!anthropicConfigured) {
    log.error("optimize.misconfigured", { requestId, missing: "ANTHROPIC_API_KEY" });
    return bad(503, "Service temporarily unavailable.");
  }

  const { dealer } = await requireDealer();

  // Reuse the 'dealer' rate-limit rule. Generating a listing is an
  // expensive call; sharing the bucket keeps a single dealer from
  // monopolising the AI budget across chat + optimize at once.
  const rate = await checkRate("dealer", dealer.id);
  if (!rate.ok) {
    return bad(429, "Too many requests for this dealership. Please wait a moment.", {
      "retry-after": String(rate.resetSec),
    });
  }

  // RLS-scoped vehicle lookup. If the row doesn't belong to this
  // dealer the policy returns no row → 404 (no leak of "exists but
  // wrong owner").
  const sb = await createServerSupabase();
  const vehicleRes = await sb
    .from("vehicles")
    .select("*")
    .eq("id", id)
    .eq("dealer_id", dealer.id)
    .maybeSingle();
  const vehicle = vehicleRes.data as VehicleRow | null;
  if (!vehicle) return bad(404, "Vehicle not found.");

  // Pre-call budget check.
  const systemChars = estimateListingChars({ dealer, vehicle });
  const estimatedUsd = estimateCallUsd(systemChars, 0, LISTING_AI_MAX_OUTPUT_TOKENS);
  try {
    await assertBudgetAvailable({ dealerId: dealer.id, estimatedUsd });
  } catch (err) {
    if (err instanceof BudgetExceededError) {
      log.warn("optimize.budget_exhausted", {
        requestId,
        dealer_id: dealer.id,
        detail: err.message,
      });
      return bad(503, "Daily AI budget reached. Try again after midnight UTC.");
    }
    throw err;
  }

  let result;
  try {
    result = await generateListingVariants({ dealer, vehicle });
  } catch (err) {
    const detail = err instanceof ListingOptimizerError ? err.message : "AI request failed";
    log.warn("optimize.ai_error", { requestId, dealer_id: dealer.id, detail });
    return bad(503, "Could not generate listings right now.");
  }

  await recordSpend({
    dealerId: dealer.id,
    inputTokens: result.usage.input_tokens,
    outputTokens: result.usage.output_tokens,
  });

  // Replace any previous suggestion set for this vehicle. We could
  // append + version, but the typical flow is "regenerate, pick one",
  // and three-row history on every reroll bloats the table fast.
  const service = createServiceSupabase();
  const wipe = await service
    .from("listing_suggestions")
    .delete()
    .eq("vehicle_id", vehicle.id)
    .is("accepted_at", null);
  if (wipe.error) {
    log.warn("optimize.wipe_failed", { requestId, code: wipe.error.code });
  }

  const rows = result.variants.map((v) => ({
    vehicle_id: vehicle.id,
    dealer_id: dealer.id,
    title: v.title,
    description: v.description,
    photo_order_hint: v.photo_order_hint.length > 0 ? v.photo_order_hint : null,
    rationale: v.rationale || null,
  }));
  const insertRes = await service
    .from("listing_suggestions")
    .insert(rows)
    .select("*");

  if (insertRes.error || !insertRes.data) {
    log.error("optimize.insert_failed", {
      requestId,
      dealer_id: dealer.id,
      code: insertRes.error?.code,
    });
    return bad(503, "Could not save listings.");
  }

  log.info("optimize.ok", {
    requestId,
    dealer_id: dealer.id,
    vehicle_id: vehicle.id,
    duration_ms: Date.now() - startedAt,
    count: insertRes.data.length,
  });

  return NextResponse.json({
    variants: insertRes.data as ListingSuggestionRow[],
  });
}

interface PatchBody {
  suggestion_id?: unknown;
  // v0.4: when true, copy the accepted suggestion's title +
  // description onto the live vehicles row so the dealer can post the
  // optimised copy directly to Marketplace without re-typing. Default
  // false (reviewer guardrail C) — destructive overwrites must be
  // opt-in. The previous title/description are captured onto the
  // accepted listing_suggestions row first (researcher risk #1) so a
  // regretful dealer can recover the prior copy.
  sync_to_vehicle?: unknown;
}

export async function PATCH(request: NextRequest, ctx: RouteContext) {
  const { id } = await ctx.params;
  if (!UUID_RE.test(id)) return bad(400, "Invalid vehicle id.");

  let body: PatchBody;
  try {
    body = (await request.json()) as PatchBody;
  } catch {
    return bad(400, "Invalid JSON.");
  }
  const suggestionId = typeof body.suggestion_id === "string" ? body.suggestion_id : "";
  if (!UUID_RE.test(suggestionId)) return bad(400, "Invalid suggestion id.");
  const syncToVehicle = body.sync_to_vehicle === true;

  const { dealer } = await requireDealer();
  const sb = await createServerSupabase();

  const updateRes = await sb
    .from("listing_suggestions")
    .update({ accepted_at: new Date().toISOString() })
    .eq("id", suggestionId)
    .eq("vehicle_id", id)
    .eq("dealer_id", dealer.id)
    .select("id,title,description");
  if (updateRes.error) {
    return bad(503, "Could not save your selection.");
  }
  const rows = (updateRes.data ?? []) as {
    id: string;
    title: string;
    description: string;
  }[];
  if (rows.length === 0) return bad(404, "Suggestion not found.");

  if (!syncToVehicle) {
    return NextResponse.json({ ok: true });
  }

  // Auto-sync path. We use the SAME RLS-scoped session client so a
  // compromised dealer session can't reach into another dealer's
  // vehicle row even though we double-filter on dealer_id below.
  const accepted = rows[0];

  // 1. Capture current title/description BEFORE we stomp them, onto
  //    the accepted suggestion row. Without this, accept-A → regen
  //    → accept-B would silently overwrite A with no audit trail
  //    (researcher risk #1).
  const vehicleRes = await sb
    .from("vehicles")
    .select("title,description")
    .eq("id", id)
    .eq("dealer_id", dealer.id)
    .maybeSingle();
  if (vehicleRes.error || !vehicleRes.data) {
    return NextResponse.json({ ok: true, sync: "failed", error: "vehicle_lookup" });
  }
  const previous = vehicleRes.data as {
    title: string | null;
    description: string | null;
  };

  const captureRes = await sb
    .from("listing_suggestions")
    .update({
      previous_title: previous.title,
      previous_description: previous.description,
    })
    .eq("id", accepted.id)
    .eq("dealer_id", dealer.id);
  if (captureRes.error) {
    log.warn("optimize.sync_capture_failed", {
      dealer_id: dealer.id,
      vehicle_id: id,
      code: captureRes.error.code,
    });
    return NextResponse.json({ ok: true, sync: "failed", error: captureRes.error.code });
  }

  // 2. Stomp vehicles.title + vehicles.description with the chosen
  //    variant. We don't update updated_at explicitly — the touch
  //    trigger on vehicles handles that.
  const stompRes = await sb
    .from("vehicles")
    .update({ title: accepted.title, description: accepted.description })
    .eq("id", id)
    .eq("dealer_id", dealer.id);
  if (stompRes.error) {
    log.warn("optimize.sync_apply_failed", {
      dealer_id: dealer.id,
      vehicle_id: id,
      code: stompRes.error.code,
    });
    return NextResponse.json({ ok: true, sync: "failed", error: stompRes.error.code });
  }

  log.info("optimize.sync_applied", {
    dealer_id: dealer.id,
    vehicle_id: id,
    suggestion_id: accepted.id,
  });
  return NextResponse.json({ ok: true, sync: "applied" });
}
