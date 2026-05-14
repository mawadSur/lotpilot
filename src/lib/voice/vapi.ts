// Vapi adapter — mirror of sms/twilio.ts. Inbound webhooks are verified
// HMAC-SHA256 over the raw body using VAPI_PRIVATE_KEY (timing-safe
// equality). Outbound `speakBack` lazy-imports the Vapi SDK so a
// build with VOICE_ENABLED=false never bundles or initialises it.
//
// Spec assumes header `x-vapi-signature` carries the hex digest.
// (Decision deferred: confirm against current Vapi docs at v0.4
// implementation; if Vapi switches to JWT, swap the verify body but
// keep the function signature.)

import { createHmac, timingSafeEqual } from "node:crypto";
import { requireVapiEnv, voiceEnabled } from "../env";
import { log } from "../log";

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

interface VapiSdk {
  // Surface guess; we never call this in v0.3, the route just acks.
  // The shape is captured here so a swap to a real SDK in v0.4 lands
  // with a typed seam already in place.
  calls: {
    speak(opts: { callId: string; text: string }): Promise<{ ok: true }>;
  };
}

async function loadVapi(): Promise<VapiSdk | null> {
  try {
    // The package name is intentionally guarded behind a runtime
    // string so `next build` with VOICE_ENABLED=false doesn't try
    // to resolve it. v0.4 wires in the real SDK; v0.3 just scaffolds
    // the seam.
    const name = "@vapi-ai/server-sdk";
    const mod = (await import(/* webpackIgnore: true */ name)) as unknown as {
      default: VapiSdk;
    };
    return mod.default;
  } catch {
    return null;
  }
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

// Outbound TTS-back. v0.3 returns { queued: false } whenever voice is
// disabled or the SDK isn't installed, so the chat pipeline can call
// this unconditionally without a feature-flag branch upstream.
export async function speakBack(args: SpeakBackArgs): Promise<SpeakBackResult> {
  if (!voiceEnabled()) {
    log.info("voice.disabled", { call_redacted: maskCallId(args.callId) });
    return { queued: false };
  }
  if (!args.callId || !args.body) {
    return { queued: false, error: "invalid_args" };
  }
  const sdk = await loadVapi();
  if (!sdk) {
    log.warn("voice.module_missing", {});
    return { queued: false, error: "vapi_module_missing" };
  }
  try {
    await sdk.calls.speak({ callId: args.callId, text: args.body });
    return { queued: true };
  } catch (err) {
    const detail = (err as Error).message;
    log.error("voice.speak_failed", { detail, call_redacted: maskCallId(args.callId) });
    return { queued: false, error: detail };
  }
}
