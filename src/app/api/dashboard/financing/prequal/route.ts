// Financing pre-qualification endpoint (v0.7 / T1.6).
//
// SECURITY-CRITICAL. Read these rules before editing:
//
//   1. Reject the FULL 9-digit SSN at the parse layer. We check the
//      raw request body string with /\b\d{9}\b/ BEFORE JSON.parse so
//      that even a caller that bypasses our field validator can never
//      ship a real SSN through. Returns 400 ssn_full_not_accepted.
//
//   2. Only `ssn_last4` is accepted, and must match /^\d{4}$/.
//      Anything else → 400 ssn_last4_invalid.
//
//   3. The request body is NEVER logged in any form. Logs are built
//      from an EXPLICIT WHITELIST of fields:
//        { provider, status, request_id, reference_hash, available }
//      No spread. No JSON.stringify(payload). No error.message in the
//      response body. The denylist in src/lib/log.ts is the second
//      layer of defence (forbidden keys + SSN regex scrubbing); this
//      whitelist is the first.
//
//   4. `reference_hash` is sha256(provider_id) — opaque to logs but
//      lets us tie a 500 back to a specific provider call when
//      diagnosing without exposing PII.
//
//   5. Rate limit: 3 / dealer / hour. v0.7.1 reuses the existing
//      `dealer` rule (120/60s) with a custom key to keep changes
//      surgical. TIGHTEN TO 3/hour IN v0.7.2 by adding a dedicated
//      rate rule with windowSec=3600 and limit=3. Until then a
//      single dealer could in theory burn ~120 SSN-guessing
//      attempts/minute against the endpoint — acceptable for v0.7.1
//      because (a) auth-gated, (b) we never echo back whether the
//      SSN matched (provider stubs throw or return available:false),
//      and (c) the founder pilot is small enough to detect abuse.

import { NextResponse } from "next/server";
import crypto from "node:crypto";
import { requireDealer } from "@/lib/auth";
import { checkRate } from "@/lib/ratelimit";
import { prequalify } from "@/lib/financing";
import type { PrequalPayload } from "@/lib/financing";
import { log } from "@/lib/log";

export const dynamic = "force-dynamic";

const FULL_SSN_RE = /\b\d{9}\b/;
const SSN_LAST4_RE = /^\d{4}$/;
const DOB_RE = /^\d{4}-\d{2}-\d{2}$/;
const ZIP_RE = /^\d{5}(-\d{4})?$/;
const STATE_RE = /^[A-Z]{2}$/;

type ValidationFailure = { field: string };

function validatePayload(parsed: unknown): PrequalPayload | ValidationFailure {
  if (!parsed || typeof parsed !== "object") return { field: "body" };
  const o = parsed as Record<string, unknown>;

  const firstName = typeof o.first_name === "string" ? o.first_name.trim() : "";
  if (!firstName || firstName.length > 100) return { field: "first_name" };

  const lastName = typeof o.last_name === "string" ? o.last_name.trim() : "";
  if (!lastName || lastName.length > 100) return { field: "last_name" };

  const dob = typeof o.dob === "string" ? o.dob : "";
  if (!DOB_RE.test(dob)) return { field: "dob" };

  const ssnLast4 = typeof o.ssn_last4 === "string" ? o.ssn_last4 : "";
  if (!SSN_LAST4_RE.test(ssnLast4)) return { field: "ssn_last4" };

  if (!o.address || typeof o.address !== "object") return { field: "address" };
  const addr = o.address as Record<string, unknown>;
  const line1 = typeof addr.line1 === "string" ? addr.line1.trim() : "";
  if (!line1 || line1.length > 200) return { field: "address.line1" };
  const city = typeof addr.city === "string" ? addr.city.trim() : "";
  if (!city || city.length > 100) return { field: "address.city" };
  const state = typeof addr.state === "string" ? addr.state.trim().toUpperCase() : "";
  if (!STATE_RE.test(state)) return { field: "address.state" };
  const zip = typeof addr.zip === "string" ? addr.zip.trim() : "";
  if (!ZIP_RE.test(zip)) return { field: "address.zip" };

  const monthlyIncome = o.monthly_income;
  if (
    typeof monthlyIncome !== "number" ||
    !Number.isFinite(monthlyIncome) ||
    monthlyIncome < 0 ||
    monthlyIncome > 10_000_000
  ) {
    return { field: "monthly_income" };
  }

  const requestedAmount = o.requested_amount;
  if (
    typeof requestedAmount !== "number" ||
    !Number.isFinite(requestedAmount) ||
    requestedAmount <= 0 ||
    requestedAmount > 10_000_000
  ) {
    return { field: "requested_amount" };
  }

  return {
    first_name: firstName,
    last_name: lastName,
    dob,
    ssn_last4: ssnLast4,
    address: { line1, city, state, zip },
    monthly_income: monthlyIncome,
    requested_amount: requestedAmount,
  };
}

export async function POST(request: Request): Promise<NextResponse> {
  const requestId = crypto.randomUUID();

  // Auth gate. requireDealer() redirects to /login or /dashboard/onboarding
  // when the session is missing or no dealer row exists.
  const { dealer } = await requireDealer();

  // Rate limit. See file header for the v0.7.1 → v0.7.2 plan: we reuse
  // the existing `dealer` rule (120/60s) with a dedicated key prefix.
  // TODO(v0.7.2): tighten to 3/hour with a dedicated rate rule.
  const rate = await checkRate("dealer", `prequal:${dealer.id}`);
  if (!rate.ok) {
    log.warn("financing.prequal.rate_limited", {
      request_id: requestId,
      dealer_id: dealer.id,
    });
    return NextResponse.json(
      { error: "rate_limited" },
      { status: 429, headers: { "retry-after": String(rate.resetSec) } },
    );
  }

  // Read raw body FIRST so we can scan for a full SSN before any parse
  // step has a chance to surface it. CRITICAL: `raw` MUST NOT appear in
  // any log line below this point.
  let raw: string;
  try {
    raw = await request.text();
  } catch {
    log.warn("financing.prequal.body_unreadable", {
      request_id: requestId,
      dealer_id: dealer.id,
    });
    return NextResponse.json({ error: "invalid_payload" }, { status: 400 });
  }

  if (FULL_SSN_RE.test(raw)) {
    // Belt-and-suspenders: refuse before parsing. We log nothing about
    // the body content — only that the rejection fired.
    log.warn("financing.prequal.full_ssn_rejected", {
      request_id: requestId,
      dealer_id: dealer.id,
    });
    return NextResponse.json({ error: "ssn_full_not_accepted" }, { status: 400 });
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    log.warn("financing.prequal.parse_failed", {
      request_id: requestId,
      dealer_id: dealer.id,
    });
    return NextResponse.json({ error: "invalid_payload" }, { status: 400 });
  }

  const validated = validatePayload(parsed);
  if ("field" in validated) {
    // We log the FIELD NAME only — never the value.
    log.warn("financing.prequal.validation_failed", {
      request_id: requestId,
      dealer_id: dealer.id,
      field: validated.field,
    });
    const errorCode =
      validated.field === "ssn_last4" ? "ssn_last4_invalid" : "invalid_payload";
    return NextResponse.json(
      { error: errorCode, field: validated.field },
      { status: 400 },
    );
  }

  // Call the provider adapter. ANY throw → generic 500. We do NOT
  // include error.message in the response body — could leak provider
  // detail or PII echoed inside an error string.
  let result;
  try {
    result = await prequalify(validated);
  } catch (err) {
    // error.message is allowed in logs (scrub layer + denylist will
    // handle accidental SSN inclusion); body stays generic.
    log.error("financing.prequal.provider_threw", {
      request_id: requestId,
      dealer_id: dealer.id,
      detail: (err as Error).message,
    });
    return NextResponse.json({ error: "provider_unavailable" }, { status: 500 });
  }

  // EXPLICIT WHITELIST log payload. Do not add fields here without
  // re-reading the file header.
  log.info("financing.prequal", {
    provider: result.available ? result.provider : "n/a",
    status: result.available ? result.status : "n/a",
    request_id: requestId,
    reference_hash: result.available ? result.reference_hash : "n/a",
    available: result.available,
  });

  // Response body mirrors the result shape directly — provider name,
  // status, reference_hash on success; reason on unavailable. The
  // input payload is never echoed.
  return NextResponse.json(result, { status: 200 });
}
