// Buyer-input sanitiser used before any text reaches the AI. Defends
// against prompt-injection by:
//   - capping length (architect: 4000 chars hard, request layer rejects 5000+)
//   - stripping ASCII control chars except newline / tab
//   - redacting any attempt to forge the BUYER_MESSAGE delimiters
//
// Returns null if the message is fundamentally invalid (empty, too long, etc.)

export const MAX_BUYER_MESSAGE_CHARS = 4000;
export const BUYER_START = "<<<BUYER_MESSAGE_START>>>";
export const BUYER_END = "<<<BUYER_MESSAGE_END>>>";

const CONTROL_CHARS = /[\x00-\x08\x0B\x0C\x0E-\x1F\x7F]/g;
const FORGED_DELIMITERS = /<<<\s*BUYER_MESSAGE_(START|END)\s*>>>/gi;

export interface SanitizedMessage {
  text: string;
  wrapped: string;
}

export function sanitizeBuyerMessage(input: unknown): SanitizedMessage | null {
  if (typeof input !== "string") return null;
  const trimmed = input.trim();
  if (trimmed.length === 0) return null;
  if (trimmed.length > MAX_BUYER_MESSAGE_CHARS) return null;

  const noControls = trimmed.replace(CONTROL_CHARS, "");
  const noForgery = noControls.replace(FORGED_DELIMITERS, "[redacted]");

  return {
    text: noForgery,
    wrapped: `${BUYER_START}\n${noForgery}\n${BUYER_END}`,
  };
}
