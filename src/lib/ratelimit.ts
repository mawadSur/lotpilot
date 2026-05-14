// Sliding-window rate limit on /api/chat. Backed by Vercel KV when
// configured; falls back to an in-process Map otherwise (single-instance
// dev only — Vercel's Lambda model means each instance has its own Map,
// so the in-memory path is best-effort).
//
// Three rules:
//   - ip            : 30 / 60s   (cheap to abuse)
//   - dealer        : 120 / 60s  (single dealership getting brigaded)
//   - conversation  : 4 / 10s    (per-thread spam; cookie-pinned)
//
// Atomic primitives only: kv.incr(key) then (if first hit) kv.expire(key, windowSec).
// Never read-then-write — race condition + lets a burst slip through.

import { kv } from "@vercel/kv";
import { kvConfigured } from "./env";
import { log } from "./log";

export type RateRule = "ip" | "dealer" | "conversation";

interface RuleConfig {
  limit: number;
  windowSec: number;
  prefix: string;
}

const RULES: Record<RateRule, RuleConfig> = {
  ip: { limit: 30, windowSec: 60, prefix: "rl:ip:" },
  dealer: { limit: 120, windowSec: 60, prefix: "rl:dealer:" },
  conversation: { limit: 4, windowSec: 10, prefix: "rl:conv:" },
};

export interface RateLimitResult {
  ok: boolean;
  remaining: number;
  resetSec: number; // seconds until window expiry
  rule: RateRule;
}

interface MemoryBucket {
  count: number;
  resetAt: number; // ms epoch
}

const memory: Map<string, MemoryBucket> = new Map();
let memoryWarned = false;

function memoryHit(key: string, cfg: RuleConfig, rule: RateRule): RateLimitResult {
  const now = Date.now();
  const bucket = memory.get(key);
  if (!bucket || bucket.resetAt <= now) {
    memory.set(key, { count: 1, resetAt: now + cfg.windowSec * 1000 });
    return { ok: true, remaining: cfg.limit - 1, resetSec: cfg.windowSec, rule };
  }
  bucket.count += 1;
  const remaining = Math.max(cfg.limit - bucket.count, 0);
  const resetSec = Math.max(Math.ceil((bucket.resetAt - now) / 1000), 0);
  return { ok: bucket.count <= cfg.limit, remaining, resetSec, rule };
}

async function kvHit(key: string, cfg: RuleConfig, rule: RateRule): Promise<RateLimitResult> {
  try {
    const count = await kv.incr(key);
    if (count === 1) {
      await kv.expire(key, cfg.windowSec);
    }
    const ttl = await kv.ttl(key);
    const resetSec = ttl > 0 ? ttl : cfg.windowSec;
    if (count > cfg.limit) {
      return { ok: false, remaining: 0, resetSec, rule };
    }
    return { ok: true, remaining: Math.max(cfg.limit - count, 0), resetSec, rule };
  } catch (err) {
    log.error("ratelimit.kv_error", { rule, detail: (err as Error).message });
    // Fail-open if KV is misbehaving — better than 503-ing every buyer.
    return { ok: true, remaining: cfg.limit, resetSec: cfg.windowSec, rule };
  }
}

// Single-rule check. Use ip → dealer → conversation in /api/chat.
export async function checkRate(rule: RateRule, key: string): Promise<RateLimitResult> {
  const cfg = RULES[rule];
  const namespaced = `${cfg.prefix}${key}`;

  if (kvConfigured) {
    return kvHit(namespaced, cfg, rule);
  }

  if (!memoryWarned) {
    memoryWarned = true;
    log.warn("ratelimit.memory_fallback", {
      reason: "KV_REST_API_URL/TOKEN unset; using in-memory bucket (dev only).",
    });
  }
  return memoryHit(namespaced, cfg, rule);
}

// Pull the buyer IP off whatever proxy is in front of us. Vercel uses
// x-forwarded-for; fall back to a placeholder so the limiter still has
// a key.
export function readClientIp(headers: Headers): string {
  const forwarded = headers.get("x-forwarded-for");
  if (forwarded) {
    const first = forwarded.split(",")[0]?.trim();
    if (first) return first;
  }
  const real = headers.get("x-real-ip");
  if (real) return real;
  return "unknown";
}
