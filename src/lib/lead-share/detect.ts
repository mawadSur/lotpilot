// T4.2 — Detect a buyer's YES / NO reply to a pending lead-share
// consent SMS.
//
// CTIA + TCPA convention: only the FIRST WORD (case-insensitive,
// stripped of punctuation) counts. "yes please send my info" → YES.
// "I'd like to but no" → NO. Anything else is not a share response
// and falls through to the normal chat pipeline.
//
// Note: STOP / HELP / START keep their existing CTIA semantics — they
// run AHEAD of lead-share detection in chat-pipeline.ts. A buyer
// hitting STOP while a share is pending → STOP wins, the share is
// cancelled with cancel_reason='opted_out' inside the same path that
// cancels follow-ups.

const YES_ALIASES = new Set(["YES", "Y", "SI", "SÍ"]);
const NO_ALIASES  = new Set(["NO", "N"]);

export type LeadShareResponse = "yes" | "no" | null;

export function detectLeadShareResponse(input: string): LeadShareResponse {
  const trimmed = input.trim();
  if (!trimmed) return null;
  const firstWord = trimmed
    .split(/\s+/, 1)[0]
    ?.replace(/[^A-Za-zÁÉÍÓÚáéíóúÑñ]/g, "")
    .toUpperCase()
    // Normalise "SÍ" → "SI" so we don't have to maintain two alias sets.
    .replace(/Í/g, "I");
  if (!firstWord) return null;
  if (YES_ALIASES.has(firstWord)) return "yes";
  if (NO_ALIASES.has(firstWord)) return "no";
  return null;
}
