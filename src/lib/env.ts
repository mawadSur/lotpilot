// Centralised env access for the Supabase + Anthropic + Upstash Redis +
// Twilio + Vapi clients. Throws loudly if the caller asks for a key
// that isn't set, rather than silently producing a half-configured
// client.
//
// v0.3 note: we kept the env-var names KV_REST_API_URL / KV_REST_API_TOKEN
// from the @vercel/kv era so existing Vercel/Upstash integrations
// continue to work without a dashboard edit. Internally we now use
// @upstash/redis, but the contract at the boundary is unchanged.

const PUBLIC_URL = process.env.NEXT_PUBLIC_SUPABASE_URL;
const ANON_KEY = process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY;
const SERVICE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY;
const ANTHROPIC_KEY = process.env.ANTHROPIC_API_KEY;

const REDIS_URL = process.env.KV_REST_API_URL;
const REDIS_TOKEN = process.env.KV_REST_API_TOKEN;

const TWILIO_SID = process.env.TWILIO_ACCOUNT_SID;
const TWILIO_TOKEN = process.env.TWILIO_AUTH_TOKEN;
const TWILIO_FROM = process.env.TWILIO_FROM_NUMBER;

const SMS_FLAG = process.env.SMS_ENABLED;

const VOICE_FLAG = process.env.VOICE_ENABLED;
const VAPI_PUBLIC = process.env.VAPI_PUBLIC_KEY;
const VAPI_PRIVATE = process.env.VAPI_PRIVATE_KEY;

const DAILY_BUDGET_USD = process.env.ANTHROPIC_DAILY_BUDGET_USD;

export const supabaseAuthConfigured = Boolean(PUBLIC_URL && ANON_KEY);
export const supabaseServiceConfigured = Boolean(PUBLIC_URL && SERVICE_KEY);
export const anthropicConfigured = Boolean(ANTHROPIC_KEY);
export const redisConfigured = Boolean(REDIS_URL && REDIS_TOKEN);
// Back-compat alias so any v0.2 caller still using the old name keeps
// compiling. Prefer `redisConfigured` going forward.
export const kvConfigured = redisConfigured;

export function smsEnabled(): boolean {
  return SMS_FLAG === "true" || SMS_FLAG === "1";
}

// Voice is gated by the flag *and* by Vapi env presence, so a
// half-configured deploy never silently mounts a webhook that would
// 5xx every callback. The /api/voice/inbound route still ack-200s when
// disabled (Vapi would otherwise retry forever).
export function voiceEnabled(): boolean {
  if (VOICE_FLAG !== "true" && VOICE_FLAG !== "1") return false;
  return Boolean(VAPI_PUBLIC && VAPI_PRIVATE);
}

export function dailyBudgetUsd(): number {
  const n = Number(DAILY_BUDGET_USD ?? 50);
  if (!Number.isFinite(n) || n <= 0) return 50;
  return n;
}

export function requireAuthEnv(): { url: string; anonKey: string } {
  if (!PUBLIC_URL || !ANON_KEY) {
    throw new Error(
      "Supabase auth not configured. Set NEXT_PUBLIC_SUPABASE_URL and NEXT_PUBLIC_SUPABASE_ANON_KEY in .env.local.",
    );
  }
  return { url: PUBLIC_URL, anonKey: ANON_KEY };
}

export function requireServiceEnv(): { url: string; serviceKey: string } {
  if (!PUBLIC_URL || !SERVICE_KEY) {
    throw new Error(
      "Supabase service role not configured. Set NEXT_PUBLIC_SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY in .env.local. Service role is server-only.",
    );
  }
  return { url: PUBLIC_URL, serviceKey: SERVICE_KEY };
}

export function requireAnthropicKey(): string {
  if (!ANTHROPIC_KEY) {
    throw new Error("ANTHROPIC_API_KEY is not set. Add it to .env.local.");
  }
  return ANTHROPIC_KEY;
}

export function requireRedisEnv(): { url: string; token: string } {
  if (!REDIS_URL || !REDIS_TOKEN) {
    throw new Error(
      "Upstash Redis not configured. Set KV_REST_API_URL and KV_REST_API_TOKEN in .env.local.",
    );
  }
  return { url: REDIS_URL, token: REDIS_TOKEN };
}

export function requireTwilioEnv(): {
  accountSid: string;
  authToken: string;
  fromNumber: string;
} {
  if (!TWILIO_SID || !TWILIO_TOKEN || !TWILIO_FROM) {
    throw new Error(
      "Twilio not configured. Set TWILIO_ACCOUNT_SID, TWILIO_AUTH_TOKEN, and TWILIO_FROM_NUMBER in .env.local.",
    );
  }
  return { accountSid: TWILIO_SID, authToken: TWILIO_TOKEN, fromNumber: TWILIO_FROM };
}

export function requireVapiEnv(): { publicKey: string; privateKey: string } {
  if (!VAPI_PUBLIC || !VAPI_PRIVATE) {
    throw new Error(
      "Vapi not configured. Set VAPI_PUBLIC_KEY and VAPI_PRIVATE_KEY in .env.local.",
    );
  }
  return { publicKey: VAPI_PUBLIC, privateKey: VAPI_PRIVATE };
}
