// Per-dealer Anthropic-spend circuit breaker. Caps per-day USD spend so
// a runaway loop or abuse spike on one dealership cannot burn the API
// key for the whole project.
//
// Cost model: input tokens × $3/M + output × $15/M (Sonnet 4.6 list).
// Pre-call estimate uses chars/3.5 as a rough token count + MAX_TOKENS
// for the response cap. Post-call records actuals from
// `result.usage.input_tokens` / `output_tokens` so the next request
// sees accurate usage.
//
// Keyed `budget:{dealer_id}:{YYYY-MM-DD-UTC}` in KV with 36h TTL.
// Falls back to an in-process Map for dev.

import { kv } from "@vercel/kv";
import { dailyBudgetUsd, kvConfigured } from "./env";
import { log } from "./log";

const INPUT_PER_MTOK = 3;
const OUTPUT_PER_MTOK = 15;

export class BudgetExceededError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "BudgetExceededError";
  }
}

function utcDayKey(): string {
  const now = new Date();
  const y = now.getUTCFullYear();
  const m = String(now.getUTCMonth() + 1).padStart(2, "0");
  const d = String(now.getUTCDate()).padStart(2, "0");
  return `${y}-${m}-${d}`;
}

function key(dealerId: string): string {
  return `budget:${dealerId}:${utcDayKey()}`;
}

function tokensFromChars(chars: number): number {
  if (chars <= 0) return 0;
  return Math.ceil(chars / 3.5);
}

export function estimateUsdFromTokens(input: number, output: number): number {
  return (input / 1_000_000) * INPUT_PER_MTOK + (output / 1_000_000) * OUTPUT_PER_MTOK;
}

export function estimateCallUsd(systemChars: number, messagesChars: number, maxOutputTokens: number): number {
  const input = tokensFromChars(systemChars + messagesChars);
  return estimateUsdFromTokens(input, maxOutputTokens);
}

interface MemoryRow {
  day: string;
  cents: number;
}

const memory: Map<string, MemoryRow> = new Map();

function memorySpent(dealerId: string): number {
  const row = memory.get(dealerId);
  if (!row) return 0;
  if (row.day !== utcDayKey()) return 0;
  return row.cents / 100;
}

function memoryAdd(dealerId: string, cents: number): void {
  const day = utcDayKey();
  const row = memory.get(dealerId);
  if (!row || row.day !== day) {
    memory.set(dealerId, { day, cents });
    return;
  }
  row.cents += cents;
}

async function readSpentUsd(dealerId: string): Promise<number> {
  if (!kvConfigured) return memorySpent(dealerId);
  try {
    const cents = (await kv.get<number>(key(dealerId))) ?? 0;
    return cents / 100;
  } catch (err) {
    log.error("budget.kv_error", { detail: (err as Error).message, op: "read" });
    return memorySpent(dealerId);
  }
}

async function addSpentCents(dealerId: string, cents: number): Promise<void> {
  if (!kvConfigured) {
    memoryAdd(dealerId, cents);
    return;
  }
  try {
    const total = await kv.incrby(key(dealerId), cents);
    if (total === cents) {
      // First write today — set TTL so we don't accumulate stale rows.
      await kv.expire(key(dealerId), 60 * 60 * 36);
    }
  } catch (err) {
    log.error("budget.kv_error", { detail: (err as Error).message, op: "incr" });
    memoryAdd(dealerId, cents);
  }
}

// Call BEFORE invoking Claude. Throws BudgetExceededError if the
// current-day spend plus the (estimated) cost of this call would
// exceed the daily cap.
export async function assertBudgetAvailable(args: {
  dealerId: string;
  estimatedUsd: number;
}): Promise<{ spentUsd: number; limitUsd: number; estimatedUsd: number }> {
  const limitUsd = dailyBudgetUsd();
  const spentUsd = await readSpentUsd(args.dealerId);
  if (spentUsd + args.estimatedUsd > limitUsd) {
    throw new BudgetExceededError(
      `daily budget exceeded: spent=$${spentUsd.toFixed(4)} estimated=$${args.estimatedUsd.toFixed(4)} limit=$${limitUsd}`,
    );
  }
  return { spentUsd, limitUsd, estimatedUsd: args.estimatedUsd };
}

// Call AFTER Claude returns to record actual usage from result.usage.
export async function recordSpend(args: {
  dealerId: string;
  inputTokens: number;
  outputTokens: number;
}): Promise<void> {
  const usd = estimateUsdFromTokens(args.inputTokens, args.outputTokens);
  const cents = Math.max(1, Math.round(usd * 100));
  await addSpentCents(args.dealerId, cents);
}

// For dashboards / health checks. Doesn't increment.
export async function readDealerBudget(dealerId: string): Promise<{
  spentUsd: number;
  limitUsd: number;
  remainingUsd: number;
}> {
  const limitUsd = dailyBudgetUsd();
  const spentUsd = await readSpentUsd(dealerId);
  return { spentUsd, limitUsd, remainingUsd: Math.max(limitUsd - spentUsd, 0) };
}
