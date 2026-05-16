// Tiny structured JSON logger. Two reasons we have one:
//   1. /api/chat needs consistent event names across many sites in v0.2
//      (rate-limit denials, AI budget trips, SMS webhooks, etc).
//   2. Buyer message text MUST NEVER reach logs. The logger redacts a
//      well-known set of PII-bearing field names defensively even if a
//      caller forgets.
//
// Usage:
//   import { log } from "@/lib/log";
//   log.info("chat.ok", { dealer_id, conversation_id });
//   log.warn("chat.rate_limited", { ip });
//   log.error("chat.ai_error", { detail });
//
// Output is one JSON line per event on stdout — matches Vercel's log
// ingestion. We deliberately keep this dep-free.

export type LogLevel = "debug" | "info" | "warn" | "error";

// Field names we will scrub regardless of the caller. If you find
// yourself wanting to log buyer text, pass a hash or a length, not the
// content.
const FORBIDDEN_KEYS = new Set<string>([
  "body",
  "message",
  "buyer_body",
  "buyer_message",
  "reply",
  "text",
  "raw",
  "raw_message",
  "raw_excerpt",
  "content",
  "email",
  "phone",
  "buyer_phone",
  "to",
  "from",
  "signature",
  "notes",
  "consent_text",
  "description",
  "auth",
  "authorization",
  "cookie",
  "set-cookie",
]);

const REDACTED = "[redacted]";
const MAX_STRING_LEN = 500;
// rough JWT shape: 3 base64url segments separated by .
const JWT_RE = /\beyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\b/g;
// v0.7 / T1.6: SSN masking as defence-in-depth. The financing pre-qual
// route rejects 9-digit runs at the parse layer, so an SSN should
// never reach a log line — but if a caller ever accidentally passes
// user-controlled text through, we mask it here too.
//   - Formatted SSN: 123-45-6789 → [ssn]
//   - Unformatted 9-digit run: 123456789 → [ssn?]
// Conservative: a 9-digit run in log output gets masked. Inventory
// mileage rarely 9-digit (1M miles is 7 digits); VINs are 17
// alphanumeric (won't match \d{9}). False-positive risk is low.
const SSN_FORMATTED_RE = /\b\d{3}-\d{2}-\d{4}\b/g;
const SSN_UNFORMATTED_RE = /\b\d{9}\b/g;

function scrubString(value: string): string {
  const noJwt = value.replace(JWT_RE, "[redacted-jwt]");
  // Order matters: mask the dashed form first so the 9-digit pass
  // doesn't see a substring of it.
  const noFormattedSsn = noJwt.replace(SSN_FORMATTED_RE, "[ssn]");
  const noSsn = noFormattedSsn.replace(SSN_UNFORMATTED_RE, "[ssn?]");
  return noSsn.length > MAX_STRING_LEN ? `${noSsn.slice(0, MAX_STRING_LEN)}…` : noSsn;
}

function scrub(value: unknown, depth = 0): unknown {
  if (depth > 4) return REDACTED;
  if (value === null || value === undefined) return value;
  if (typeof value === "string") return scrubString(value);
  if (typeof value === "number" || typeof value === "boolean") return value;
  if (value instanceof Date) return value.toISOString();
  if (Array.isArray(value)) {
    return value.slice(0, 50).map((v) => scrub(v, depth + 1));
  }
  if (typeof value === "object") {
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
      if (FORBIDDEN_KEYS.has(k.toLowerCase())) {
        out[k] = REDACTED;
        continue;
      }
      out[k] = scrub(v, depth + 1);
    }
    return out;
  }
  return REDACTED;
}

function emit(level: LogLevel, event: string, fields: Record<string, unknown>): void {
  const payload = {
    ts: new Date().toISOString(),
    level,
    event,
    ...(scrub(fields) as Record<string, unknown>),
  };
  const line = JSON.stringify(payload);
  if (level === "error") {
    console.error(line);
  } else if (level === "warn") {
    console.warn(line);
  } else {
    console.log(line);
  }
}

export const log = {
  debug(event: string, fields: Record<string, unknown> = {}): void {
    if (process.env.NODE_ENV === "production") return;
    emit("debug", event, fields);
  },
  info(event: string, fields: Record<string, unknown> = {}): void {
    emit("info", event, fields);
  },
  warn(event: string, fields: Record<string, unknown> = {}): void {
    emit("warn", event, fields);
  },
  error(event: string, fields: Record<string, unknown> = {}): void {
    emit("error", event, fields);
  },
};
