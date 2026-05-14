// TCPA consent text rendered to the buyer in the public chat widget /
// SMS / voice channels AND stored verbatim in the `consents` row
// whenever a buyer's first message hits the chat pipeline.
//
// Keep these strings parameterised by dealer name only — no PII, no
// per-buyer interpolation — so the verbatim text in the DB row matches
// what we showed in the UI.
//
// v0.4 (carry-over C4): per-channel copy. Web and SMS unchanged from
// v0.3. Relay is dealer-internal only — no buyer was contacted, so the
// chat pipeline SKIPS the consent insert (see chat-pipeline.ts) and
// `relayConsentText` exists purely so any future audit-export still has
// a documented disposition string. Voice has its own TCPA-compliant
// copy because call-recording + AI-processing requires explicit notice.

export function webWidgetConsentText(dealerName: string): string {
  return [
    `By sending a message you agree to receive automated responses from ${dealerName} via this chat.`,
    "Standard data rates apply.",
    "Reply STOP to opt out, HELP for help.",
  ].join(" ");
}

export function smsConsentText(dealerName: string): string {
  return [
    `By texting ${dealerName} you agree to receive automated SMS replies.`,
    "Msg & data rates may apply. Msg freq varies.",
    "Reply STOP to opt out, HELP for help.",
  ].join(" ");
}

// Voice channel: TCPA-compliant disclosure for call-recording +
// AI-processing. Reviewer guardrail: must NOT reuse SMS copy — voice
// requires explicit recording notice, and "Msg & data rates" is a
// category error on a phone call.
export function voiceConsentText(dealerName: string): string {
  return [
    `By calling ${dealerName} you consent to this voice conversation being recorded and processed by AI to generate a response.`,
    "Standard call rates may apply.",
    "Say STOP at any time to opt out, HELP for help.",
  ].join(" ");
}

// Relay channel: dealer-internal Marketplace paste/copy workflow. The
// chat pipeline skips the consent INSERT for this channel entirely
// (see chat-pipeline.ts § "First buyer message?"), so this string is
// reference-only — useful for audit exports or a future "explain this
// row" UI in the dashboard.
export function relayConsentText(dealerName: string): string {
  return [
    `This is a dealer-internal AI draft for ${dealerName} to paste into Marketplace.`,
    "No buyer was contacted by LotPilot through this turn; no TCPA consent applies.",
  ].join(" ");
}
