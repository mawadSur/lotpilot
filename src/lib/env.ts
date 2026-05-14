// Centralised env access for the Supabase + Anthropic + Vercel KV +
// Twilio clients. Throws loudly if the caller asks for a key that isn't
// set, rather than silently producing a half-configured client.

const PUBLIC_URL = process.env.NEXT_PUBLIC_SUPABASE_URL;
const ANON_KEY = process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY;
const SERVICE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY;
const ANTHROPIC_KEY = process.env.ANTHROPIC_API_KEY;

const KV_URL = process.env.KV_REST_API_URL;
const KV_TOKEN = process.env.KV_REST_API_TOKEN;

const TWILIO_SID = process.env.TWILIO_ACCOUNT_SID;
const TWILIO_TOKEN = process.env.TWILIO_AUTH_TOKEN;
const TWILIO_FROM = process.env.TWILIO_FROM_NUMBER;

const SMS_FLAG = process.env.SMS_ENABLED;

const DAILY_BUDGET_USD = process.env.ANTHROPIC_DAILY_BUDGET_USD;

export const supabaseAuthConfigured = Boolean(PUBLIC_URL && ANON_KEY);
export const supabaseServiceConfigured = Boolean(PUBLIC_URL && SERVICE_KEY);
export const anthropicConfigured = Boolean(ANTHROPIC_KEY);
export const kvConfigured = Boolean(KV_URL && KV_TOKEN);

export function smsEnabled(): boolean {
  return SMS_FLAG === "true" || SMS_FLAG === "1";
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
