// Twilio adapter — outbound SMS only. Inbound webhooks live in
// /api/sms/inbound and call back into this file for signature
// verification.
//
// SMS is feature-flagged via SMS_ENABLED. When the flag is off (or env
// vars missing), sendSms returns { queued: false, error?: reason } so
// the rest of the app keeps working without Twilio.

import { requireTwilioEnv, smsEnabled } from "../env";
import { log } from "../log";

export interface SendSmsArgs {
  to: string; // E.164
  body: string;
}

export interface SendSmsResult {
  queued: boolean;
  sid?: string;
  error?: string;
}

const E164 = /^\+[1-9][0-9]{7,14}$/;

export function maskPhone(p: string): string {
  if (!p) return "";
  if (p.length <= 5) return p;
  return `${p.slice(0, 3)}…${p.slice(-2)}`;
}

// twilio's .d.ts uses `export = TwilioSDK`, where TwilioSDK is both a
// callable factory AND a namespace with `validateRequest`. We model that
// here so the dynamic import gives us a typed handle.
interface TwilioFactory {
  (accountSid: string, authToken: string): TwilioClient;
  validateRequest(authToken: string, signature: string, url: string, params: Record<string, string>): boolean;
}

interface TwilioClient {
  messages: {
    create(opts: { to: string; from: string; body: string }): Promise<{ sid: string }>;
  };
}

async function loadTwilio(): Promise<TwilioFactory | null> {
  try {
    const mod = (await import("twilio")) as unknown as { default: TwilioFactory };
    return mod.default;
  } catch {
    return null;
  }
}

export async function sendSms(args: SendSmsArgs): Promise<SendSmsResult> {
  if (!smsEnabled()) {
    log.info("sms.disabled", { to_redacted: maskPhone(args.to) });
    return { queued: false };
  }
  if (!E164.test(args.to)) {
    log.warn("sms.invalid_to", { to_redacted: maskPhone(args.to) });
    return { queued: false, error: "invalid_to" };
  }
  if (!args.body || args.body.length > 1600) {
    return { queued: false, error: "invalid_body" };
  }

  const twilioFactory = await loadTwilio();
  if (!twilioFactory) {
    log.error("sms.module_missing", {});
    return { queued: false, error: "twilio_module_missing" };
  }

  let env: ReturnType<typeof requireTwilioEnv>;
  try {
    env = requireTwilioEnv();
  } catch (err) {
    log.error("sms.misconfigured", { detail: (err as Error).message });
    return { queued: false, error: "misconfigured" };
  }

  const client = twilioFactory(env.accountSid, env.authToken);
  try {
    const msg = await client.messages.create({
      to: args.to,
      from: env.fromNumber,
      body: args.body,
    });
    log.info("sms.sent", { sid: msg.sid, to_redacted: maskPhone(args.to) });
    return { queued: true, sid: msg.sid };
  } catch (err) {
    const detail = (err as Error).message;
    log.error("sms.send_failed", { detail, to_redacted: maskPhone(args.to) });
    return { queued: false, error: detail };
  }
}

// Twilio inbound-webhook signature verification. MUST be called as the
// very first thing in /api/sms/inbound — before parsing the form body,
// before any DB lookup. Twilio signs URL + sorted params with the
// auth token; we recompute and compare with timing-safe equality
// (validateRequest does this internally).
export async function verifyTwilioSignature(args: {
  url: string;
  params: Record<string, string>;
  signature: string | null;
}): Promise<boolean> {
  if (!args.signature) return false;
  const twilioFactory = await loadTwilio();
  if (!twilioFactory) return false;
  let env: ReturnType<typeof requireTwilioEnv>;
  try {
    env = requireTwilioEnv();
  } catch {
    return false;
  }
  return twilioFactory.validateRequest(env.authToken, args.signature, args.url, args.params);
}
