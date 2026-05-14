// TCPA consent text rendered to the buyer in the public chat widget AND
// stored verbatim in the `consents` row whenever a buyer's first
// message hits the chat pipeline.
//
// Keep these strings parameterised by dealer name only — no PII, no
// per-buyer interpolation — so the verbatim text in the DB row matches
// what we showed in the UI.

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
