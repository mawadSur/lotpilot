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

// v0.4: Calendly webhook signing key. When unset, the webhook ack-200s
// silently so a half-configured deploy doesn't 5xx every Calendly retry.
const CALENDLY_SECRET = process.env.CALENDLY_WEBHOOK_SECRET;

// v0.5: optional Calendly REST API token. When set, the webhook resolves
// the event_type → owner via api.calendly.com/event_types/<id> *before*
// the slug-substring heuristic. Cache hit short-circuits subsequent
// calls. Absent → fall through to the v0.4 heuristic.
const CALENDLY_API_KEY = process.env.CALENDLY_API_KEY;

// v0.6: master HMAC secret for the LotPilot Marketplace browser
// extension. We derive a PER-DEALER secret via
//   HKDF-SHA256(master, salt=dealer_id, info='lotpilot.marketplace.v1')
// (see src/lib/marketplace/extension.ts → deriveDealerSecret) so a
// leaked extension binary only spoofs the one dealer it was issued to,
// not every dealer in the pilot. Renamed from MARKETPLACE_EXTENSION_SECRET
// (v0.5) — the old name still resolves via fallback below so deploys
// can roll the env var without a hot config swap.
//
// Required when /api/marketplace/inbound is mounted; absent → 503 hard
// fail (no point pretending to receive inbound when we can't
// authenticate it).
const MARKETPLACE_MASTER_SECRET =
  process.env.MARKETPLACE_MASTER_SECRET ?? process.env.MARKETPLACE_EXTENSION_SECRET;

// v0.7: optional previous master secret used during a master-secret
// rotation. When set, /api/marketplace/inbound retries HMAC
// verification against the prev master on a current-master miss for
// version >= 2 installs — and writes a 'marketplace_secret_rotated'
// system_warnings row so the dealer can re-issue the binary at their
// convenience. Absent → no grace window (failed sigs just 403).
const MARKETPLACE_MASTER_SECRET_PREV = process.env.MARKETPLACE_MASTER_SECRET_PREV;

// v0.7: bearer token guarding /api/internal/drain-audit-queue. Vercel
// cron hits the endpoint every 5 minutes; the token is set as an env
// var in Vercel and matched constant-time on the server. Absent →
// endpoint 503s.
const INTERNAL_DRAIN_TOKEN = process.env.INTERNAL_DRAIN_TOKEN;

// v0.7 trade-in valuation (T1.5). Provider 'none' (or unset) returns
// a stubbed { available: false } payload — no fetch. KBB is the
// primary provider; Manheim MMR support is scaffolded but the SDK
// shape isn't fully decided yet.
const TRADE_IN_PROVIDER = process.env.TRADE_IN_PROVIDER ?? "none";
const KBB_API_KEY = process.env.KBB_API_KEY;
const MANHEIM_CLIENT_ID = process.env.MANHEIM_CLIENT_ID;
const MANHEIM_CLIENT_SECRET = process.env.MANHEIM_CLIENT_SECRET;

// v0.7 financing pre-qual (T1.6). Provider 'none' (or unset) returns
// a stubbed { available: false } payload. RouteOne is the primary;
// 700Credit / Capital One scaffolded.
const FINANCING_PROVIDER = process.env.FINANCING_PROVIDER ?? "none";
const ROUTE_ONE_API_KEY = process.env.ROUTE_ONE_API_KEY;
const ROUTE_ONE_DEALER_ID = process.env.ROUTE_ONE_DEALER_ID;
const SEVEN_HUNDRED_CREDIT_API_KEY = process.env.SEVEN_HUNDRED_CREDIT_API_KEY;
if (
  !process.env.MARKETPLACE_MASTER_SECRET &&
  process.env.MARKETPLACE_EXTENSION_SECRET
) {
  // One release of transitional support — log loudly once at module
  // load so the deploy operator notices the rename. Drop in v0.7.
  console.warn(
    JSON.stringify({
      level: "warn",
      event: "env.marketplace_secret_legacy_name",
      detail:
        "MARKETPLACE_EXTENSION_SECRET is deprecated; rename to MARKETPLACE_MASTER_SECRET.",
    }),
  );
}

// v0.5: Meta WhatsApp Cloud API. Two secrets, distinct purposes:
//   WHATSAPP_VERIFY_TOKEN: shared string Meta echoes back during the
//     one-time GET /whatsapp/inbound subscription verification.
//   WHATSAPP_APP_SECRET: HMAC-SHA256 key Meta uses to sign POST bodies
//     (X-Hub-Signature-256 = `sha256=<hex>`). Verified BEFORE parse.
// Required when the route is wired live; absent → POST 503, GET 403.
const WHATSAPP_VERIFY_TOKEN = process.env.WHATSAPP_VERIFY_TOKEN;
const WHATSAPP_APP_SECRET = process.env.WHATSAPP_APP_SECRET;

// v0.6: outbound WhatsApp Cloud API credentials. Three values, all
// required when we actually attempt outbound:
//   WHATSAPP_PHONE_NUMBER_ID: registered phone-number id we POST to.
//   WHATSAPP_ACCESS_TOKEN:    system-user bearer token.
//   WHATSAPP_TEMPLATE_NAME:   approved hello/utility template, used when
//                              the 24h window is closed.
// All three absent → outbound returns {queued:false} and the message
// stays approval_status='pending' so the dealer can hand-reply in the
// inbox. Half-configured → same posture (we don't pretend to send).
const WHATSAPP_PHONE_NUMBER_ID = process.env.WHATSAPP_PHONE_NUMBER_ID;
const WHATSAPP_ACCESS_TOKEN = process.env.WHATSAPP_ACCESS_TOKEN;
const WHATSAPP_TEMPLATE_NAME = process.env.WHATSAPP_TEMPLATE_NAME;

// v0.8 — Stripe billing. Five env vars, all required for a live billing
// surface (Checkout, portal, webhook all 503 when missing). The price
// ids are looked up via getTierPriceId() in src/lib/stripe.ts so a
// missing price for a given tier 503s only that tier's checkout call,
// not every other configured tier.
const STRIPE_SECRET_KEY = process.env.STRIPE_SECRET_KEY;
const STRIPE_WEBHOOK_SECRET = process.env.STRIPE_WEBHOOK_SECRET;
const STRIPE_PRICE_STARTER = process.env.STRIPE_PRICE_STARTER;
const STRIPE_PRICE_PRO = process.env.STRIPE_PRICE_PRO;
const STRIPE_PRICE_NETWORK = process.env.STRIPE_PRICE_NETWORK;

export const supabaseAuthConfigured = Boolean(PUBLIC_URL && ANON_KEY);
export const supabaseServiceConfigured = Boolean(PUBLIC_URL && SERVICE_KEY);
export const anthropicConfigured = Boolean(ANTHROPIC_KEY);
export const redisConfigured = Boolean(REDIS_URL && REDIS_TOKEN);
export const calendlyConfigured = Boolean(CALENDLY_SECRET);
export const calendlyApiConfigured = Boolean(CALENDLY_API_KEY);
export const marketplaceExtensionConfigured = Boolean(MARKETPLACE_MASTER_SECRET);
export const marketplaceMasterPrevConfigured = Boolean(MARKETPLACE_MASTER_SECRET_PREV);
export const internalDrainConfigured = Boolean(INTERNAL_DRAIN_TOKEN);
export type TradeInProviderName = "none" | "kbb" | "manheim";
export type FinancingProviderName = "none" | "route_one" | "seven_hundred_credit";
export const tradeInProvider: TradeInProviderName =
  TRADE_IN_PROVIDER === "kbb" || TRADE_IN_PROVIDER === "manheim"
    ? TRADE_IN_PROVIDER
    : "none";
export const financingProvider: FinancingProviderName =
  FINANCING_PROVIDER === "route_one" || FINANCING_PROVIDER === "seven_hundred_credit"
    ? FINANCING_PROVIDER
    : "none";
// Tells the adapter "we have what we need to actually call the API" —
// adapter returns { available: false } when this is false.
export const kbbConfigured = Boolean(KBB_API_KEY);
export const manheimConfigured = Boolean(MANHEIM_CLIENT_ID && MANHEIM_CLIENT_SECRET);
export const routeOneConfigured = Boolean(ROUTE_ONE_API_KEY && ROUTE_ONE_DEALER_ID);
export const sevenHundredCreditConfigured = Boolean(SEVEN_HUNDRED_CREDIT_API_KEY);
export const whatsappVerifyConfigured = Boolean(WHATSAPP_VERIFY_TOKEN);
export const whatsappPostConfigured = Boolean(WHATSAPP_APP_SECRET);
export const whatsappOutboundConfigured = Boolean(
  WHATSAPP_PHONE_NUMBER_ID && WHATSAPP_ACCESS_TOKEN && WHATSAPP_TEMPLATE_NAME,
);
// v0.8 — true when the minimum surface for a live Stripe integration is
// present (secret key + webhook secret). Per-tier price-id presence is
// checked separately in getTierPriceId(); a deploy missing one price is
// still "configured enough" for the other two tiers to checkout.
export const stripeConfigured = Boolean(STRIPE_SECRET_KEY && STRIPE_WEBHOOK_SECRET);
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

export function requireCalendlySecret(): string {
  if (!CALENDLY_SECRET) {
    throw new Error(
      "Calendly webhook signing key not configured. Set CALENDLY_WEBHOOK_SECRET in .env.local.",
    );
  }
  return CALENDLY_SECRET;
}

export function requireCalendlyApiKey(): string {
  if (!CALENDLY_API_KEY) {
    throw new Error(
      "Calendly REST API key not configured. Set CALENDLY_API_KEY in .env.local.",
    );
  }
  return CALENDLY_API_KEY;
}

export function requireMarketplaceMasterSecret(): string {
  if (!MARKETPLACE_MASTER_SECRET) {
    throw new Error(
      "Marketplace master secret not configured. Set MARKETPLACE_MASTER_SECRET in .env.local (or the legacy MARKETPLACE_EXTENSION_SECRET).",
    );
  }
  return MARKETPLACE_MASTER_SECRET;
}

// v0.7: optional, never throws — callers check marketplaceMasterPrevConfigured first.
export function readMarketplaceMasterPrev(): string | null {
  return MARKETPLACE_MASTER_SECRET_PREV ?? null;
}

export function requireInternalDrainToken(): string {
  if (!INTERNAL_DRAIN_TOKEN) {
    throw new Error("INTERNAL_DRAIN_TOKEN not configured.");
  }
  return INTERNAL_DRAIN_TOKEN;
}

export function readKbbApiKey(): string | null { return KBB_API_KEY ?? null; }
export function readManheimCreds(): { id: string; secret: string } | null {
  if (!MANHEIM_CLIENT_ID || !MANHEIM_CLIENT_SECRET) return null;
  return { id: MANHEIM_CLIENT_ID, secret: MANHEIM_CLIENT_SECRET };
}
export function readRouteOneCreds(): { apiKey: string; dealerId: string } | null {
  if (!ROUTE_ONE_API_KEY || !ROUTE_ONE_DEALER_ID) return null;
  return { apiKey: ROUTE_ONE_API_KEY, dealerId: ROUTE_ONE_DEALER_ID };
}
export function readSevenHundredCreditKey(): string | null {
  return SEVEN_HUNDRED_CREDIT_API_KEY ?? null;
}

export function requireWhatsappVerifyToken(): string {
  if (!WHATSAPP_VERIFY_TOKEN) {
    throw new Error(
      "WhatsApp verify token not configured. Set WHATSAPP_VERIFY_TOKEN in .env.local.",
    );
  }
  return WHATSAPP_VERIFY_TOKEN;
}

export function requireWhatsappAppSecret(): string {
  if (!WHATSAPP_APP_SECRET) {
    throw new Error(
      "WhatsApp app secret not configured. Set WHATSAPP_APP_SECRET in .env.local.",
    );
  }
  return WHATSAPP_APP_SECRET;
}

export function requireWhatsappOutboundEnv(): {
  phoneNumberId: string;
  accessToken: string;
  templateName: string;
} {
  if (!WHATSAPP_PHONE_NUMBER_ID || !WHATSAPP_ACCESS_TOKEN || !WHATSAPP_TEMPLATE_NAME) {
    throw new Error(
      "WhatsApp outbound not configured. Set WHATSAPP_PHONE_NUMBER_ID, WHATSAPP_ACCESS_TOKEN, and WHATSAPP_TEMPLATE_NAME in .env.local.",
    );
  }
  return {
    phoneNumberId: WHATSAPP_PHONE_NUMBER_ID,
    accessToken: WHATSAPP_ACCESS_TOKEN,
    templateName: WHATSAPP_TEMPLATE_NAME,
  };
}

// v0.8 — Stripe accessors. Two surfaces:
//   * requireStripeSecretKey / requireStripeWebhookSecret throw when
//     missing — used by the lazy Stripe client init + webhook verifier.
//   * readStripePriceId(tier) returns the configured price id for a
//     given tier, or null. Letting the caller decide how to fail (we
//     return a typed 503 in /api/stripe/checkout) keeps env.ts free of
//     route-level concerns.
export function requireStripeSecretKey(): string {
  if (!STRIPE_SECRET_KEY) {
    throw new Error("STRIPE_SECRET_KEY is not set. Add it to .env.local.");
  }
  return STRIPE_SECRET_KEY;
}

export function requireStripeWebhookSecret(): string {
  if (!STRIPE_WEBHOOK_SECRET) {
    throw new Error("STRIPE_WEBHOOK_SECRET is not set. Add it to .env.local.");
  }
  return STRIPE_WEBHOOK_SECRET;
}

export function readStripePriceId(
  tier: "starter" | "pro" | "network",
): string | null {
  switch (tier) {
    case "starter":
      return STRIPE_PRICE_STARTER ?? null;
    case "pro":
      return STRIPE_PRICE_PRO ?? null;
    case "network":
      return STRIPE_PRICE_NETWORK ?? null;
    default:
      return null;
  }
}
