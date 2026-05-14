// Sliding-window rate limit on /api/chat (and friends). Backed by
// Upstash Redis when configured; falls back to an in-process Map
// otherwise (single-instance dev only — Vercel's Lambda model means
// each instance has its own Map, so the in-memory path is best-effort).
//
// Three rules:
//   - ip            : 30 / 60s   (cheap to abuse)
//   - dealer        : 120 / 60s  (single dealership getting brigaded)
//   - conversation  : 4 / 10s    (per-thread spam; cookie-pinned)
//
// v0.3 swap: @vercel/kv (fixed-window incr+expire) → @upstash/ratelimit
// (sliding window). Slightly stricter at burst boundaries — accepted;
// the new primitive is better-behaved overall. Env vars unchanged.

import { Ratelimit } from "@upstash/ratelimit";
import { redisConfigured } from "./env";
import { getRedis } from "./redis";
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

// One Ratelimit instance per rule, lazily constructed so the Redis
// client isn't built until first hit. @upstash/ratelimit needs Redis
// at construction; getRedis() throws if KV_REST_API_URL/TOKEN are unset
// — which we guard with redisConfigured before ever calling here.
const limiters: Partial<Record<RateRule, Ratelimit>> = {};

function getLimiter(rule: RateRule, cfg: RuleConfig): Ratelimit {
  const cached = limiters[rule];
  if (cached) return cached;
  const built = new Ratelimit({
    redis: getRedis(),
    limiter: Ratelimit.slidingWindow(cfg.limit, `${cfg.windowSec} s`),
    prefix: cfg.prefix.replace(/:$/, ""),
    analytics: false,
  });
  limiters[rule] = built;
  return built;
}

async function redisHit(key: string, cfg: RuleConfig, rule: RateRule): Promise<RateLimitResult> {
  try {
    const result = await getLimiter(rule, cfg).limit(key);
    const now = Date.now();
    // Upstash returns reset as an epoch-millis. Convert to seconds-from-
    // now. Floor at 0 so a clock-skewed "already reset" value can't
    // produce a negative Retry-After header.
    const resetSec = Math.max(Math.ceil((result.reset - now) / 1000), 0);
    return {
      ok: result.success,
      remaining: Math.max(result.remaining, 0),
      resetSec: resetSec > 0 ? resetSec : cfg.windowSec,
      rule,
    };
  } catch (err) {
    log.error("ratelimit.redis_error", { rule, detail: (err as Error).message });
    // Fail-open: better to risk a burst than 503 every buyer when
    // Upstash blips.
    return { ok: true, remaining: cfg.limit, resetSec: cfg.windowSec, rule };
  }
}

// Single-rule check. Use ip → dealer → conversation in /api/chat.
export async function checkRate(rule: RateRule, key: string): Promise<RateLimitResult> {
  const cfg = RULES[rule];
  const namespaced = `${cfg.prefix}${key}`;

  if (redisConfigured) {
    return redisHit(key, cfg, rule);
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
