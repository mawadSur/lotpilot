// WhatsApp Cloud API adapter — v0.6 outbound activation.
//
// Inbound webhook + signature path lives below the outbound block.
// Outbound:
//   - We post to https://graph.facebook.com/v18.0/<phone_number_id>/messages
//     with a system-user bearer token. Both come from env (see env.ts).
//   - 24h messaging window: Meta only lets us send free-form `text`
//     messages within 24h of the latest inbound buyer message. We
//     query the messages table for the latest role='buyer' row in the
//     conversation; if it's within 24h, we send a `text` message. If
//     not, we attempt a `template` send with WHATSAPP_TEMPLATE_NAME
//     (the dealer's pre-approved utility template).
//   - Failure paths (window closed + no template, 401 from Meta,
//     transient 5xx) return { queued: false, error: <code> } so the
//     chat pipeline logs + leaves message approval_status='pending'.
//     v0.6 deliberately does NOT auto-retry; the dealer sees the
//     message in their inbox and can hand-reply.
//   - 8s AbortSignal timeout. Never throws — all errors return a
//     shaped result.

import { createHmac, timingSafeEqual } from "node:crypto";
import type { SupabaseClient } from "@supabase/supabase-js";
import {
  requireWhatsappAppSecret,
  requireWhatsappOutboundEnv,
  requireWhatsappVerifyToken,
  whatsappOutboundConfigured,
} from "../env";
import { log } from "../log";

// 24h messaging window — Meta hard rule. We compute "now - 24h" and
// compare against the latest buyer message in the conversation.
const WHATSAPP_WINDOW_MS = 24 * 60 * 60 * 1000;
const WHATSAPP_OUTBOUND_URL_BASE = "https://graph.facebook.com/v18.0";
const WHATSAPP_OUTBOUND_TIMEOUT_MS = 8_000;

export interface WhatsAppSendArgs {
  to: string; // E.164
  body: string;
  conversationId: string;
  // Service-role client is required (we read `messages` table for the
  // 24h-window check). chat-pipeline.ts owns the client lifecycle and
  // hands us a borrowed reference.
  sb: SupabaseClient;
}

export type WhatsAppSendError =
  | "disabled"
  | "invalid_to"
  | "invalid_body"
  | "misconfigured"
  | "window_closed_template_unverified"
  | "auth_failed"
  | "transient"
  | "unknown";

export interface WhatsAppSendResult {
  queued: boolean;
  messageId?: string;
  // Discriminates between "we know we cannot send" (window_closed
  // etc) and "graph 5xx, try again later". Surfaced to chat-pipeline
  // so it can decide whether to write a system_warnings row.
  error?: WhatsAppSendError;
  // Hint for the caller — true when the failure was authoritative
  // enough to warrant flagging the operator (e.g. 401 from Meta).
  raiseWarning?: boolean;
}

// Has the buyer sent anything within the 24h window? Returns true
// when they have (so we may text), false when they haven't (template
// required). Errors fall through to "no" — when we can't tell, the
// safer answer is template-or-bust.
async function buyerInsideWindow(
  sb: SupabaseClient,
  conversationId: string,
): Promise<boolean> {
  const sinceIso = new Date(Date.now() - WHATSAPP_WINDOW_MS).toISOString();
  const res = await sb
    .from("messages")
    .select("id", { count: "exact", head: true })
    .eq("conversation_id", conversationId)
    .eq("role", "buyer")
    .gt("created_at", sinceIso);
  if (res.error) return false;
  return (res.count ?? 0) > 0;
}

interface GraphTextBody {
  messaging_product: "whatsapp";
  to: string;
  type: "text";
  text: { body: string; preview_url: false };
}
interface GraphTemplateBody {
  messaging_product: "whatsapp";
  to: string;
  type: "template";
  template: {
    name: string;
    language: { code: "en_US" };
  };
}

interface GraphSuccess {
  messages: { id: string }[];
}
interface GraphError {
  error: {
    code: number;
    message?: string;
    type?: string;
  };
}

function isGraphSuccess(value: unknown): value is GraphSuccess {
  return (
    typeof value === "object" &&
    value !== null &&
    Array.isArray((value as { messages?: unknown }).messages) &&
    typeof ((value as GraphSuccess).messages[0]?.id) === "string"
  );
}

function isGraphError(value: unknown): value is GraphError {
  return (
    typeof value === "object" &&
    value !== null &&
    typeof (value as { error?: unknown }).error === "object" &&
    (value as { error: { code?: unknown } }).error.code !== undefined
  );
}

async function postGraph(
  body: GraphTextBody | GraphTemplateBody,
): Promise<{
  ok: true;
  messageId: string;
} | {
  ok: false;
  status: number;
  error?: WhatsAppSendError;
  raiseWarning?: boolean;
}> {
  let env: ReturnType<typeof requireWhatsappOutboundEnv>;
  try {
    env = requireWhatsappOutboundEnv();
  } catch {
    return { ok: false, status: 0, error: "misconfigured" };
  }
  const url = `${WHATSAPP_OUTBOUND_URL_BASE}/${env.phoneNumberId}/messages`;

  let res: Response;
  try {
    res = await fetch(url, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${env.accessToken}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(WHATSAPP_OUTBOUND_TIMEOUT_MS),
    });
  } catch {
    return { ok: false, status: 0, error: "transient" };
  }

  let parsed: unknown = null;
  try {
    parsed = await res.json();
  } catch {
    // Body wasn't JSON — fall through to status-based handling.
  }

  if (res.ok && isGraphSuccess(parsed)) {
    return { ok: true, messageId: parsed.messages[0].id };
  }

  if (res.status === 401 || res.status === 403) {
    return { ok: false, status: res.status, error: "auth_failed", raiseWarning: true };
  }

  if (isGraphError(parsed)) {
    // Meta uses error.code 131047 / 131026 etc for "outside window".
    // Treat any 4xx other than 401/403 as a hard failure we shouldn't
    // retry; transient = 5xx.
    if (res.status >= 500) {
      return { ok: false, status: res.status, error: "transient" };
    }
    return { ok: false, status: res.status, error: "unknown", raiseWarning: false };
  }

  if (res.status >= 500) {
    return { ok: false, status: res.status, error: "transient" };
  }
  return { ok: false, status: res.status, error: "unknown" };
}

const E164 = /^\+[1-9][0-9]{7,14}$/;
const WA_ID = /^[0-9]{8,15}$/;

// Meta wants the recipient as a wa_id (digits only, no leading +).
// Defensively accept either E.164 or bare digits and convert.
function toWaId(to: string): string | null {
  if (!to) return null;
  const trimmed = to.trim();
  if (E164.test(trimmed)) return trimmed.slice(1);
  if (WA_ID.test(trimmed)) return trimmed;
  return null;
}

export async function sendWhatsAppMessage(
  args: WhatsAppSendArgs,
): Promise<WhatsAppSendResult> {
  // Half-configured deploys: don't pretend we sent. The chat pipeline
  // already mirrors this for SMS — keep the buyer in the dealer's
  // approve-before-send queue instead.
  if (!whatsappOutboundConfigured) {
    log.info("whatsapp.send.disabled", {});
    return { queued: false, error: "disabled" };
  }
  const waId = toWaId(args.to);
  if (!waId) return { queued: false, error: "invalid_to" };
  if (!args.body || args.body.length > 4_000) {
    return { queued: false, error: "invalid_body" };
  }

  const insideWindow = await buyerInsideWindow(args.sb, args.conversationId);

  if (insideWindow) {
    const result = await postGraph({
      messaging_product: "whatsapp",
      to: waId,
      type: "text",
      text: { body: args.body, preview_url: false },
    });
    if (result.ok) {
      return { queued: true, messageId: result.messageId };
    }
    if (result.error === "auth_failed") {
      return { queued: false, error: "auth_failed", raiseWarning: true };
    }
    return { queued: false, error: result.error ?? "unknown" };
  }

  // Window closed: try the template.
  let templateName: string;
  try {
    templateName = requireWhatsappOutboundEnv().templateName;
  } catch {
    return { queued: false, error: "misconfigured" };
  }
  const templateResult = await postGraph({
    messaging_product: "whatsapp",
    to: waId,
    type: "template",
    template: {
      name: templateName,
      language: { code: "en_US" },
    },
  });
  if (templateResult.ok) {
    return { queued: true, messageId: templateResult.messageId };
  }
  if (templateResult.error === "auth_failed") {
    return { queued: false, error: "auth_failed", raiseWarning: true };
  }
  // Window closed AND template failed → return the discriminating
  // error so chat-pipeline leaves the message pending.
  return {
    queued: false,
    error: "window_closed_template_unverified",
    raiseWarning: true,
  };
}

// -------------------------------------------------------------------
// Inbound: signature + verification helpers.

const HEX_PREFIX = "sha256=";
const HEX_SIG_RE = /^[A-Fa-f0-9]{64}$/;

// Verify the X-Hub-Signature-256 header on a Meta Cloud API webhook.
//
// Meta sends the value as the literal string "sha256=<hex>". We strip
// the prefix BEFORE the timing-safe compare. HMAC is computed over the
// RAW request body bytes — we keep `rawBody` as a string here because
// fetch() in Next route handlers gives us .text(); Meta's signing uses
// UTF-8 byte equality which Node's createHmac handles when we pass
// the same string back in 'utf8' mode.
//
// MUST be called as the very first thing in POST /api/whatsapp/inbound
// — before parsing JSON, before any DB lookup.
export function verifyWhatsAppSignature(args: {
  rawBody: string;
  header: string | null;
}): boolean {
  if (!args.header) return false;
  if (!args.header.startsWith(HEX_PREFIX)) return false;
  const sig = args.header.slice(HEX_PREFIX.length);
  if (!HEX_SIG_RE.test(sig)) return false;

  let secret: string;
  try {
    secret = requireWhatsappAppSecret();
  } catch {
    return false;
  }
  const expected = createHmac("sha256", secret).update(args.rawBody, "utf8").digest("hex");
  if (expected.length !== sig.length) return false;
  try {
    return timingSafeEqual(Buffer.from(expected, "hex"), Buffer.from(sig, "hex"));
  } catch {
    return false;
  }
}

// One-time GET verification handshake. Meta calls this with three
// query params at subscription time and expects the challenge value
// echoed back when our verify token matches.
export function checkWhatsAppGetVerification(args: {
  mode: string | null;
  token: string | null;
  challenge: string | null;
}): { ok: boolean; challenge: string } {
  if (args.mode !== "subscribe") return { ok: false, challenge: "" };
  if (!args.token || !args.challenge) return { ok: false, challenge: "" };
  let expected: string;
  try {
    expected = requireWhatsappVerifyToken();
  } catch {
    return { ok: false, challenge: "" };
  }
  // Constant-time-ish: we still leak the token length, but the verify
  // token is shared in advance and isn't a high-value secret.
  if (args.token !== expected) return { ok: false, challenge: "" };
  return { ok: true, challenge: args.challenge };
}

// -------------------------------------------------------------------
// Payload typing — narrow surface used by the route handler. We only
// model what we read; full Meta v18 payloads are huge.

export interface WhatsAppInboundMessage {
  from: string; // sender wa_id ("15555550100" — no leading +)
  text: string;
  messageId: string;
  timestamp: string;
  // The dealer-side display number, e.g. "+15555550199". We use this
  // to resolve dealers.whatsapp_number.
  dealerDisplayNumber: string;
}

interface WhatsAppEntryValue {
  messages?: Array<{
    from?: string;
    id?: string;
    timestamp?: string;
    type?: string;
    text?: { body?: string };
  }>;
  metadata?: {
    display_phone_number?: string;
    phone_number_id?: string;
  };
  statuses?: unknown[];
}

interface WhatsAppEntry {
  changes?: Array<{
    value?: WhatsAppEntryValue;
    field?: string;
  }>;
}

interface WhatsAppPayload {
  entry?: WhatsAppEntry[];
}

// Extract the first message + the dealer's display number from a
// Meta payload. Returns null when the payload is a status update,
// non-text message, or shape we don't understand — caller responds
// 200 noop in that case (Meta retries non-2xx forever).
export function extractFirstWhatsAppMessage(raw: string): WhatsAppInboundMessage | null {
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return null;
  }
  if (!parsed || typeof parsed !== "object") return null;
  const p = parsed as WhatsAppPayload;
  const change = p.entry?.[0]?.changes?.[0]?.value;
  if (!change) return null;
  const msg = change.messages?.[0];
  if (!msg) return null; // status-only payload, no inbound message
  if (msg.type !== "text") return null;
  const from = typeof msg.from === "string" ? msg.from : "";
  const text = typeof msg.text?.body === "string" ? msg.text.body : "";
  const id = typeof msg.id === "string" ? msg.id : "";
  const timestamp = typeof msg.timestamp === "string" ? msg.timestamp : "";
  const dealerDisplay = typeof change.metadata?.display_phone_number === "string"
    ? change.metadata.display_phone_number
    : "";
  if (!from || !text.trim() || !id || !dealerDisplay) return null;
  return {
    from,
    text,
    messageId: id,
    timestamp,
    dealerDisplayNumber: dealerDisplay,
  };
}

// Meta's `from` field is a wa_id ("15555550100" — no leading +). E.164
// requires a leading +. Dealer display numbers usually arrive with a
// leading + already, but defensively prepend if missing.
export function normaliseE164(raw: string): string | null {
  const trimmed = raw.trim();
  if (!trimmed) return null;
  const withPlus = trimmed.startsWith("+") ? trimmed : `+${trimmed}`;
  if (!/^\+[1-9][0-9]{7,14}$/.test(withPlus)) return null;
  return withPlus;
}
