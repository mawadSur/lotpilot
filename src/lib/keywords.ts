// TCPA / SMS keyword detection. Used by the chat pipeline (web AND sms
// channels) so the same buyer text gets the same auto-reply behaviour
// regardless of where it came in.
//
// Per-spec mapping — we only persist the canonical 3:
//   STOP / END / QUIT / CANCEL / UNSUBSCRIBE  => stored as 'STOP'
//   HELP / INFO                                => stored as 'HELP'
//   START                                      => stored as 'START'
//
// We intentionally only match the FIRST WORD (case-insensitive) so
// "I want to STOP by tomorrow" doesn't trip the opt-out. CTIA guidance.

import type { KeywordHit, Lang } from "./db-types";

const STOP_ALIASES = new Set(["STOP", "END", "QUIT", "CANCEL", "UNSUBSCRIBE"]);
const HELP_ALIASES = new Set(["HELP", "INFO"]);
const START_ALIASES = new Set(["START"]);

export function detectKeyword(input: string): KeywordHit | null {
  const trimmed = input.trim();
  if (!trimmed) return null;
  const firstWord = trimmed
    .split(/\s+/, 1)[0]
    ?.replace(/[^A-Za-z]/g, "")
    .toUpperCase();
  if (!firstWord) return null;
  if (STOP_ALIASES.has(firstWord)) return "STOP";
  if (HELP_ALIASES.has(firstWord)) return "HELP";
  if (START_ALIASES.has(firstWord)) return "START";
  return null;
}

// Bilingual canned replies. Returned verbatim by the chat pipeline,
// skipping Claude entirely.
export function autoReplyFor(
  keyword: KeywordHit,
  dealerName: string,
  language: Lang,
): string {
  if (keyword === "STOP") {
    return language === "es"
      ? `${dealerName}: te hemos quitado de la lista. No recibirás más mensajes en este canal. Responde START para volver a recibir mensajes.`
      : `${dealerName}: you won't receive replies on this channel. Reply START to resume.`;
  }
  if (keyword === "HELP") {
    return language === "es"
      ? `${dealerName}: somos un concesionario. Responde con tu pregunta y te contestamos. STOP para cancelar.`
      : `For help, contact ${dealerName} directly. Msg freq varies. Reply STOP to cancel.`;
  }
  // START
  return language === "es"
    ? `${dealerName}: ya estás dentro. Pregunta lo que quieras.`
    : `${dealerName}: you're back in. Ask anything.`;
}

// Used when a suppressed buyer sends a non-START message — generic ack
// that we received them but won't reply because they opted out.
export function suppressedAck(dealerName: string, language: Lang): string {
  return language === "es"
    ? `${dealerName}: cancelaste los mensajes. Responde START para reanudar.`
    : `${dealerName}: you opted out. Reply START to resume.`;
}
