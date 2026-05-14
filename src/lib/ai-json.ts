// Shared JSON-extractor for Claude responses. Both the chat reply
// engine (lib/ai.ts) and the listing optimizer (lib/listing-optimizer.ts)
// rely on the same "respond with ONLY a JSON value" contract; extracting
// the parser keeps them honest about the cleanup rules and means a
// markdown-fence regression in one place fixes both.

// Strips ```json / ``` fences, trims, then either parses the whole
// string or extracts the first balanced { ... } / [ ... ] blob and
// parses that. Returns null on anything we can't make sense of — the
// caller decides whether to retry or surface an error.

function stripFences(raw: string): string {
  return raw
    .trim()
    .replace(/^```json\s*/i, "")
    .replace(/^```\s*/i, "")
    .replace(/\s*```$/i, "");
}

export function parseModelObject(raw: string): Record<string, unknown> | null {
  const cleaned = stripFences(raw);
  try {
    const parsed: unknown = JSON.parse(cleaned);
    if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
      return parsed as Record<string, unknown>;
    }
  } catch {
    // Fall through to the extracted-blob attempt.
  }
  const match = cleaned.match(/\{[\s\S]*\}/);
  if (!match) return null;
  try {
    const parsed: unknown = JSON.parse(match[0]);
    if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
      return parsed as Record<string, unknown>;
    }
  } catch {
    return null;
  }
  return null;
}

export function parseModelArray(raw: string): unknown[] | null {
  const cleaned = stripFences(raw);
  try {
    const parsed: unknown = JSON.parse(cleaned);
    if (Array.isArray(parsed)) return parsed;
  } catch {
    // Fall through to the extracted-blob attempt.
  }
  const match = cleaned.match(/\[[\s\S]*\]/);
  if (!match) return null;
  try {
    const parsed: unknown = JSON.parse(match[0]);
    if (Array.isArray(parsed)) return parsed;
  } catch {
    return null;
  }
  return null;
}
