// Single Upstash Redis client. v0.3 swapped @vercel/kv → @upstash/redis;
// env-var contract is unchanged (KV_REST_API_URL / KV_REST_API_TOKEN)
// so existing Vercel/Upstash integrations keep working without a
// dashboard edit.
//
// Lazy: never construct the client until first use. @upstash/ratelimit
// requires a Redis at construction time, so callers (ratelimit.ts,
// budget.ts) MUST guard with `redisConfigured` before touching this.

import { Redis } from "@upstash/redis";
import { requireRedisEnv } from "./env";

let cached: Redis | null = null;

export function getRedis(): Redis {
  if (cached) return cached;
  const { url, token } = requireRedisEnv();
  cached = new Redis({ url, token });
  return cached;
}
