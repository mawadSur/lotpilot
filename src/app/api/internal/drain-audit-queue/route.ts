// Drains the pending_compliance_audits outbox into compliance_exports.
//
// Runs every 5 minutes via Vercel cron (see vercel.json at repo root).
// Vercel cron sends GET by default, but we also accept POST so a
// human operator can prod it from curl when investigating a stuck
// queue. Both methods authenticate via a constant-time bearer-token
// check against INTERNAL_DRAIN_TOKEN.
//
// Design notes:
//   - Service-role supabase client: pending_compliance_audits has no
//     authenticated UPDATE/DELETE policy on purpose (only the drainer
//     mutates), and the cron has no dealer context — RLS would block
//     every read otherwise.
//   - Best-effort, at-least-once: we drain up to 100 rows per tick in
//     created_at-asc order. Each row is processed independently —
//     a single failed insert increments attempts and leaves
//     completed_at null so the next tick re-claims it.
//   - No row IDs in logs (PII-adjacent — attached to exports).
//     Aggregate counts only.

import { NextResponse, type NextRequest } from "next/server";
import { timingSafeEqual } from "node:crypto";
import { createServiceSupabase } from "@/lib/supabase-service";
import {
  internalDrainConfigured,
  requireInternalDrainToken,
} from "@/lib/env";
import { log } from "@/lib/log";
import type {
  ComplianceExportScope,
  PendingComplianceAuditRow,
} from "@/lib/db-types";

export const dynamic = "force-dynamic";

// Cap per-tick to bound lambda runtime; 100 rows is well within the
// 10s budget for a sequential insert+update pair.
const DRAIN_BATCH = 100;

interface DrainResult {
  claimed: number;
  succeeded: number;
  failed: number;
}

// Constant-time bearer check. Length pre-check is required because
// timingSafeEqual throws on mismatched lengths — we'd leak length via
// the throw path. Returns true only on exact match.
function authorize(request: NextRequest): boolean {
  const header = request.headers.get("authorization") ?? "";
  const prefix = "Bearer ";
  if (!header.startsWith(prefix)) return false;
  const actual = header.slice(prefix.length);
  const expected = requireInternalDrainToken();
  if (actual.length !== expected.length) return false;
  try {
    return timingSafeEqual(Buffer.from(actual), Buffer.from(expected));
  } catch {
    return false;
  }
}

async function drain(): Promise<DrainResult> {
  const sb = createServiceSupabase();

  // Claim up to DRAIN_BATCH oldest pending rows. The partial index
  // pending_compliance_audits_drain_idx (migration 0009) makes this
  // a fast index scan even at high volumes.
  const claimRes = await sb
    .from("pending_compliance_audits")
    .select("*")
    .is("completed_at", null)
    .order("created_at", { ascending: true })
    .limit(DRAIN_BATCH);
  if (claimRes.error) {
    log.error("audit_queue.drain.claim_failed", {
      code: claimRes.error.code,
      message: claimRes.error.message,
    });
    return { claimed: 0, succeeded: 0, failed: 0 };
  }
  const rows = (claimRes.data ?? []) as PendingComplianceAuditRow[];

  let succeeded = 0;
  let failed = 0;
  const nowIso = new Date().toISOString();

  for (const row of rows) {
    // Materialise the compliance_exports audit row. We carry every
    // dealer-facing field forward verbatim so the regulator-visible
    // table is identical to the v0.6 schema.
    const insertRes = await sb.from("compliance_exports").insert({
      dealer_id: row.dealer_id,
      exported_by: row.exported_by,
      scope: row.scope as ComplianceExportScope,
      scope_payload: row.scope_payload,
      row_count: row.row_count,
    });
    if (insertRes.error) {
      failed += 1;
      // Re-claim on next tick. We deliberately leave completed_at
      // null and bump attempts so an operator can SELECT
      // "attempts >= N" to surface stuck rows.
      const bumpRes = await sb
        .from("pending_compliance_audits")
        .update({
          attempts: row.attempts + 1,
          last_attempted_at: nowIso,
          last_error: insertRes.error.message ?? "insert_failed",
        })
        .eq("id", row.id);
      if (bumpRes.error) {
        log.error("audit_queue.drain.bump_failed", {
          code: bumpRes.error.code,
        });
      }
      continue;
    }
    // Mark complete. If THIS update fails we'd double-write on the
    // next tick — that's the at-least-once tradeoff and acceptable
    // for an audit log (regulators prefer dupes to missing rows).
    const doneRes = await sb
      .from("pending_compliance_audits")
      .update({
        completed_at: nowIso,
        last_attempted_at: nowIso,
        attempts: row.attempts + 1,
      })
      .eq("id", row.id);
    if (doneRes.error) {
      log.error("audit_queue.drain.complete_failed", {
        code: doneRes.error.code,
      });
      failed += 1;
      continue;
    }
    succeeded += 1;
  }

  return { claimed: rows.length, succeeded, failed };
}

async function handle(request: NextRequest): Promise<NextResponse> {
  if (!internalDrainConfigured) {
    return NextResponse.json(
      { error: "drain_not_configured" },
      { status: 503 },
    );
  }
  if (!authorize(request)) {
    return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  }

  const result = await drain();
  log.info("audit_queue.drain", {
    claimed: result.claimed,
    succeeded: result.succeeded,
    failed: result.failed,
  });
  return NextResponse.json(result, { status: 200 });
}

export async function GET(request: NextRequest): Promise<NextResponse> {
  return handle(request);
}

export async function POST(request: NextRequest): Promise<NextResponse> {
  return handle(request);
}
