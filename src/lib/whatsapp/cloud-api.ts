// WhatsApp Cloud API adapter — v0.5 stub.
//
// Real outbound delivery via the Meta Graph API requires:
//   - a verified Meta Business
//   - a registered Phone Number ID + System User access token
//   - 24h messaging window OR a pre-approved message template
//
// None of that is in scope for v0.5 — the only thing we ship is the
// inbound webhook + signature path, so the dealer can SEE WhatsApp
// messages flow into the inbox and approve them in the existing
// approve-before-send queue. Outbound is a no-op until v0.6, when we
// flip it on after the WABA bookkeeping is done.
//
// The route handler logs the would-send payload + masked recipient
// so the v0.6 wiring is "swap stub for real fetch + happy path is
// already exercised in the inbox UI."

import { createHmac, timingSafeEqual } from "node:crypto";
import { requireWhatsappAppSecret, requireWhatsappVerifyToken } from "../env";

export interface WhatsAppSendArgs {
  to: string; // E.164
  body: string;
}

export interface WhatsAppSendResult {
  queued: boolean;
  messageId?: string;
  error?: string;
}

export async function sendWhatsAppMessage(
  args: WhatsAppSendArgs,
): Promise<WhatsAppSendResult> {
  // v0.5 stub. Returns queued:false unconditionally so the route
  // handler can call it without a feature-flag branch. We touch the
  // arg surface so a future wiring change picks up a TS error if the
  // shape drifts.
  void args.to;
  void args.body;
  return { queued: false, error: "whatsapp_send_not_wired_in_v05" };
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
