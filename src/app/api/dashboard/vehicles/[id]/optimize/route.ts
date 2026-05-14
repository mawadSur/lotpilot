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

  const { dealer } = await requireDealer();
  const sb = await createServerSupabase();

  const updateRes = await sb
    .from("listing_suggestions")
    .update({ accepted_at: new Date().toISOString() })
    .eq("id", suggestionId)
    .eq("vehicle_id", id)
    .eq("dealer_id", dealer.id)
    .select("id");
  if (updateRes.error) {
    return bad(503, "Could not save your selection.");
  }
  const rows = (updateRes.data ?? []) as { id: string }[];
  if (rows.length === 0) return bad(404, "Suggestion not found.");

  return NextResponse.json({ ok: true });
}
