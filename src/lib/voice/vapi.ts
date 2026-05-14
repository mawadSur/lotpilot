// Vapi adapter — mirror of sms/twilio.ts. Inbound webhooks are verified
// HMAC-SHA256 over the raw body using VAPI_PRIVATE_KEY (timing-safe
// equality). Outbound `speakBack` POSTs to Vapi's call-control endpoint
// to inject TTS into a live call.
//
// Why direct fetch and not @vapi-ai/server-sdk:
//   - The SDK (v1.2.0) exposes `client.calls.{list,create,get,delete,
//     update}` only. The TTS-during-call control is delivered over the
//     SDK's WebSocket-style `ClientInboundMessageSay` channel, which is
//     designed to be sent FROM the assistant runtime (i.e. by code
//     running inside Vapi's container), not from a third-party server
//     hitting Vapi over HTTP. The natural HTTP analog is the documented
//     POST /call/{id}/control endpoint with `{ type: "say", message }`,
//     which we use here.
//   - Bonus: dropping the SDK from the import graph means the lambda
//     cold-start doesn't pay for 7.5MB of Fern-generated client code
//     just to send one POST.
// The SDK is kept in package.json `optionalDependencies` for any
// future caller (e.g. provisioning a new call), but speakBack does not
// load it.

import { createHmac, timingSafeEqual } from "node:crypto";
import { requireVapiEnv, voiceEnabled } from "../env";
import { log } from "../log";

const VAPI_API_HOST = "https://api.vapi.ai";
const TIMEOUT_MS = 5000;
const MAX_ATTEMPTS = 2;
const RETRY_BACKOFF_MS = 250;

export interface VapiTranscriptPayload {
  callId: string;
  from: string;       // E.164
  to: string;         // E.164 — dealer.voice_number
  transcript: string; // buyer-side STT
  timestamp: string;
}

export interface SpeakBackArgs {
  callId: string;
  body: string;
}

export interface SpeakBackResult {
  queued: boolean;
  error?: string;
}

const HEX_SIG_RE = /^[A-Fa-f0-9]{64}$/;

export function maskCallId(id: string): string {
  if (!id) return "";
  if (id.length <= 8) return id;
  return `${id.slice(0, 4)}…${id.slice(-3)}`;
}

// Verify an inbound webhook. MUST be called as the very first thing in
// /api/voice/inbound — before parsing the body, before any DB lookup.
// Returns true iff the signature header matches HMAC-SHA256(body) under
// VAPI_PRIVATE_KEY, compared with timingSafeEqual.
export async function verifyVapiSignature(args: {
  rawBody: string;
  signature: string | null;
}): Promise<boolean> {
  if (!args.signature) return false;
  if (!HEX_SIG_RE.test(args.signature)) return false;
  let env: ReturnType<typeof requireVapiEnv>;
  try {
    env = requireVapiEnv();
  } catch {
    return false;
  }
  const expected = createHmac("sha256", env.privateKey).update(args.rawBody, "utf8").digest("hex");
  if (expected.length !== args.signature.length) return false;
  try {
    return timingSafeEqual(Buffer.from(expected, "hex"), Buffer.from(args.signature, "hex"));
  } catch {
    return false;
  }
}

// Outbound TTS-back. Returns { queued: false } whenever voice is
// disabled or the POST fails, so the chat pipeline / voice route can
// call this unconditionally without a feature-flag branch upstream.
//
// Two attempts max with a small backoff (mirror calendly-api.ts). 5s
// per-attempt timeout via AbortController. Vapi documents a transient
// 5xx surface around peak load; retrying once on 5xx + abort is cheap
// insurance. We do NOT retry 4xx — those are deterministic (call ended,
// call id wrong, auth bad).
export async function speakBack(args: SpeakBackArgs): Promise<SpeakBackResult> {
  if (!voiceEnabled()) {
    log.info("voice.disabled", { call_redacted: maskCallId(args.callId) });
    return { queued: false };
  }
  if (!args.callId || !args.body) {
    return { queued: false, error: "invalid_args" };
  }
  let env: ReturnType<typeof requireVapiEnv>;
  try {
    env = requireVapiEnv();
  } catch (err) {
    log.error("voice.misconfigured", { detail: (err as Error).message });
    return { queued: false, error: "misconfigured" };
  }

  for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt += 1) {
    const result = await postOnce(args, env.privateKey);
    if (result.kind === "ok") {
      log.info("voice.spoken", { attempt, call_redacted: maskCallId(args.callId) });
      return { queued: true };
    }
    if (result.kind === "client_error") {
      log.warn("voice.speak_client_error", {
        attempt,
        status: result.status,
        call_redacted: maskCallId(args.callId),
      });
      return { queued: false, error: `vapi_${result.status}` };
    }
    if (attempt < MAX_ATTEMPTS) {
      await sleep(RETRY_BACKOFF_MS);
    } else {
      log.error("voice.speak_exhausted", {
        attempts: attempt,
        kind: result.kind,
        detail: result.detail,
        call_redacted: maskCallId(args.callId),
      });
      return { queued: false, error: result.detail ?? result.kind };
    }
  }
  return { queued: false, error: "exhausted" };
}

type PostResult =
  | { kind: "ok" }
  | { kind: "client_error"; status: number }
  | { kind: "server_error"; status: number; detail?: string }
  | { kind: "abort"; detail: string }
  | { kind: "unreachable"; detail: string };

async function postOnce(args: SpeakBackArgs, privateKey: string): Promise<PostResult> {
  const url = `${VAPI_API_HOST}/call/${encodeURIComponent(args.callId)}/control`;
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), TIMEOUT_MS);
  try {
    const res = await fetch(url, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${privateKey}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({ type: "say", message: args.body }),
      signal: controller.signal,
    });
    if (res.status >= 200 && res.status < 300) return { kind: "ok" };
    if (res.status >= 400 && res.status < 500) {
      return { kind: "client_error", status: res.status };
    }
    return { kind: "server_error", status: res.status };
  } catch (err) {
    const e = err as Error;
    if (e.name === "AbortError") return { kind: "abort", detail: "timeout" };
    return { kind: "unreachable", detail: e.message };
  } finally {
    clearTimeout(timer);
  }
}

function sleep(ms: number): Promise<void> {
  return new Promise((res) => setTimeout(res, ms));
}
