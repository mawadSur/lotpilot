// POST /api/dashboard/trade-in/value — return a trade-in valuation for
// the authenticated dealer. v0.7.1 scaffold: the route handler is
// production-ready (auth, rate-limit, strict input validation, stable
// error envelope), but every live provider (KBB, Manheim) currently
// throws on configured deploys because the upstream API contracts
// aren't finalised. The dispatcher in `@/lib/trade-in` returns the
// stable `{ available: false }` shape when the provider is "none" or
// unconfigured; otherwise the throw is caught here and rendered as
// `provider_unavailable`.
//
// Posture mirrors the rest of /api/dashboard/*:
//   - requireDealer() for session + dealer scoping.
//   - checkRate("dealer", ...) for the 120/min ceiling.
//   - NextResponse.json envelopes ({ error, field } on validation
//     failure, raw result on success). HTTP status drives the dealer
//     UI's retry behaviour; the JSON body drives the message.
//
// Validation philosophy mirrors `parseScope` in
// `src/app/api/dashboard/compliance/export/route.ts:64-91`: explicit
// per-field checks, early return with the failing field name so the
// frontend can highlight it. No schema library — the cost isn't worth
// adding one for six fields.

import { NextResponse, type NextRequest } from "next/server";
import { requireDealer } from "@/lib/auth";
import { checkRate } from "@/lib/ratelimit";
import { valueVehicle, type TradeInPayload } from "@/lib/trade-in";
import { log } from "@/lib/log";

export const dynamic = "force-dynamic";

const ZIP_RE = /^\d{5}$/;
// VIN: 17 chars, no I/O/Q to avoid 1/0 confusion (ISO 3779).
const VIN_RE = /^[A-HJ-NPR-Z0-9]{17}$/i;
const CONDITIONS = new Set(["excellent", "good", "fair", "poor"]);
const MAKE_MODEL_MAX_LEN = 50;
const MILEAGE_MAX = 500_000;
const YEAR_MIN = 1980;

type ValidationError = { field: string };
type ValidatedPayload = TradeInPayload;

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isInteger(value: unknown): value is number {
  return typeof value === "number" && Number.isInteger(value);
}

function validate(body: unknown): ValidatedPayload | ValidationError {
  if (!isPlainObject(body)) return { field: "body" };

  // year — integer in [1980, currentYear + 1]. The +1 covers the
  // model-year window where dealers list next year's cars in Q4.
  const yearMax = new Date().getUTCFullYear() + 1;
  const year = body.year;
  if (!isInteger(year) || year < YEAR_MIN || year > yearMax) {
    return { field: "year" };
  }

  // make / model — non-empty trimmed strings, ≤50 chars.
  const make = body.make;
  if (typeof make !== "string") return { field: "make" };
  const makeTrim = make.trim();
  if (makeTrim.length === 0 || makeTrim.length > MAKE_MODEL_MAX_LEN) {
    return { field: "make" };
  }

  const model = body.model;
  if (typeof model !== "string") return { field: "model" };
  const modelTrim = model.trim();
  if (modelTrim.length === 0 || modelTrim.length > MAKE_MODEL_MAX_LEN) {
    return { field: "model" };
  }

  // mileage — integer in [0, 500000].
  const mileage = body.mileage;
  if (!isInteger(mileage) || mileage < 0 || mileage > MILEAGE_MAX) {
    return { field: "mileage" };
  }

  // condition — enum.
  const condition = body.condition;
  if (typeof condition !== "string" || !CONDITIONS.has(condition)) {
    return { field: "condition" };
  }

  // zip — 5 digits.
  const zip = body.zip;
  if (typeof zip !== "string" || !ZIP_RE.test(zip)) {
    return { field: "zip" };
  }

  // vin — optional. Reject empty strings here (force the caller to
  // omit the key rather than pass "") so the provider adapter can
  // trust `payload.vin` is either undefined or a valid VIN.
  let vin: string | undefined;
  if (body.vin !== undefined && body.vin !== null) {
    if (typeof body.vin !== "string") return { field: "vin" };
    const vinTrim = body.vin.trim();
    if (vinTrim.length > 0) {
      if (!VIN_RE.test(vinTrim)) return { field: "vin" };
      vin = vinTrim.toUpperCase();
    }
  }

  return {
    year,
    make: makeTrim,
    model: modelTrim,
    mileage,
    condition: condition as TradeInPayload["condition"],
    zip,
    ...(vin ? { vin } : {}),
  };
}

export async function POST(request: NextRequest) {
  const { dealer } = await requireDealer();

  const rate = await checkRate("dealer", `tradein:${dealer.id}`);
  if (!rate.ok) {
    return new NextResponse("rate_limited", {
      status: 429,
      headers: { "retry-after": String(rate.resetSec) },
    });
  }

  let body: unknown;
  try {
    body = await request.json();
  } catch {
    return NextResponse.json({ error: "invalid_json" }, { status: 400 });
  }

  const validated = validate(body);
  if ("field" in validated) {
    return NextResponse.json(
      { error: "invalid_payload", field: validated.field },
      { status: 400 },
    );
  }

  try {
    const result = await valueVehicle(validated);
    log.info("tradein.value", {
      dealer_id: dealer.id,
      available: result.available,
      provider: result.available ? result.provider : null,
      reason: result.available ? null : result.reason,
    });
    return NextResponse.json(result);
  } catch (err) {
    log.error("tradein.provider_error", {
      dealer_id: dealer.id,
      detail: err instanceof Error ? err.message : "unknown",
    });
    return NextResponse.json(
      { error: "provider_unavailable" },
      { status: 500 },
    );
  }
}
