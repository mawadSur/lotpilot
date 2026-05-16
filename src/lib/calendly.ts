// Calendly webhook adapter. Inbound webhooks are signed with an HMAC-
// SHA256 over `${unix_timestamp}.${raw_body}` using
// CALENDLY_WEBHOOK_SECRET. The header takes the form
//   calendly-webhook-signature: t=<unix>,v1=<hex_digest>
// We pin a 5-minute replay window: if `now - t` exceeds 300s we reject
// even if the digest matches, because any signature replayed after that
// window is by definition not from a fresh Calendly delivery.
//
// Verification MUST be the very first thing the route handler does —
// before parsing the body, before any DB lookup. Otherwise the JSON
// parser becomes a DoS surface for an unauthenticated POST.

import { createHmac, timingSafeEqual } from "node:crypto";

const REPLAY_WINDOW_SEC = 5 * 60;
const HEX_SIG_RE = /^[A-Fa-f0-9]{64}$/;
const TIMESTAMP_RE = /^[0-9]{1,15}$/;

export interface VerifyArgs {
  rawBody: string;
  signatureHeader: string | null;
  secret: string;
  // Override `now` for tests; defaults to wall-clock seconds.
  nowSec?: number;
}

export interface VerifyResult {
  ok: boolean;
  reason?:
    | "missing_header"
    | "malformed_header"
    | "bad_timestamp"
    | "replay_window_expired"
    | "bad_signature_format"
    | "signature_mismatch";
}

interface ParsedHeader {
  t: number; // unix seconds
  v1: string; // hex
}

function parseHeader(header: string): ParsedHeader | null {
  // Calendly format: comma-separated `key=value` pairs in any order.
  // Whitespace inside is uncommon but tolerate it.
  const parts = header.split(",");
  let t: number | null = null;
  let v1: string | null = null;
  for (const p of parts) {
    const [rawKey, rawValue] = p.split("=", 2);
    if (!rawKey || rawValue == null) continue;
    const key = rawKey.trim();
    const value = rawValue.trim();
    if (key === "t" && TIMESTAMP_RE.test(value)) {
      const n = Number(value);
      if (Number.isFinite(n) && n > 0) t = n;
    } else if (key === "v1" && HEX_SIG_RE.test(value)) {
      v1 = value;
    }
  }
  if (t == null || v1 == null) return null;
  return { t, v1 };
}

export function verifyCalendlySignature(args: VerifyArgs): VerifyResult {
  if (!args.signatureHeader) return { ok: false, reason: "missing_header" };
  const parsed = parseHeader(args.signatureHeader);
  if (!parsed) return { ok: false, reason: "malformed_header" };
  if (!Number.isInteger(parsed.t) || parsed.t <= 0) {
    return { ok: false, reason: "bad_timestamp" };
  }

  const now = args.nowSec ?? Math.floor(Date.now() / 1000);
  if (Math.abs(now - parsed.t) > REPLAY_WINDOW_SEC) {
    return { ok: false, reason: "replay_window_expired" };
  }

  if (!HEX_SIG_RE.test(parsed.v1)) {
    return { ok: false, reason: "bad_signature_format" };
  }

  const expected = createHmac("sha256", args.secret)
    .update(`${parsed.t}.${args.rawBody}`, "utf8")
    .digest("hex");

  if (expected.length !== parsed.v1.length) {
    return { ok: false, reason: "signature_mismatch" };
  }
  let ok: boolean;
  try {
    ok = timingSafeEqual(Buffer.from(expected, "hex"), Buffer.from(parsed.v1, "hex"));
  } catch {
    return { ok: false, reason: "signature_mismatch" };
  }
  return ok ? { ok: true } : { ok: false, reason: "signature_mismatch" };
}

// ----------------------------------------------------------------------
// Payload typing — narrow surface used by the webhook handler. We do
// NOT model the full Calendly schema because (a) it's huge and (b) the
// webhook handler refuses to act on anything other than
// `event === 'invitee.created'`.

export interface CalendlyInviteeCreatedPayload {
  event: "invitee.created";
  payload: {
    event: {
      uri: string;
      start_time: string; // ISO8601
      event_type: { uri: string };
    };
    invitee: {
      email: string | null;
      text_reminder_number: string | null;
    };
    tracking?: {
      utm_content?: string | null;
    };
  };
}

export function isInviteeCreated(
  raw: unknown,
): raw is CalendlyInviteeCreatedPayload {
  if (!raw || typeof raw !== "object") return false;
  const r = raw as Record<string, unknown>;
  if (r.event !== "invitee.created") return false;
  if (!r.payload || typeof r.payload !== "object") return false;
  const p = r.payload as Record<string, unknown>;
  if (!p.event || typeof p.event !== "object") return false;
  if (!p.invitee || typeof p.invitee !== "object") return false;
  const evt = p.event as Record<string, unknown>;
  if (typeof evt.start_time !== "string") return false;
  if (typeof evt.uri !== "string") return false;
  if (!evt.event_type || typeof evt.event_type !== "object") return false;
  if (typeof (evt.event_type as Record<string, unknown>).uri !== "string") return false;
  return true;
}

// v0.7 / T1.9 note: Calendly also fires `invitee.event_ended` once an
// event's end time has passed (independent of attendance). T1.9 uses
// the cron sweep (`/api/internal/drain-follow-ups` →
// sweepCompletedTestDrives) as its trigger instead of subscribing to
// that event — the sweep handles both Calendly-booked and AI-booked
// (chat-pipeline placeholder scheduled_at) test drives uniformly, and
// keeps the webhook route surface untouched for T1.7's reminder logic.
