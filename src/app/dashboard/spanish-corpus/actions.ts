"use server";

// /dashboard/spanish-corpus — add-row server action.
//
// Uses the RLS-scoped server client (NOT service-role). RLS on
// `spanish_phrases` already enforces:
//   - dealer_id must be the caller's dealer (or NULL, but the policy
//     forbids authenticated INSERT of NULL — globals are seeded by
//     service-role only).
//   - created_by must equal auth.uid().
// We pass exactly those values; the policy double-checks.

import { revalidatePath } from "next/cache";
import { requireDealer, requireUser } from "@/lib/auth";
import { createServerSupabase } from "@/lib/supabase-server";
import { log } from "@/lib/log";
import type { SpanishPhraseIntent } from "@/lib/db-types";

export type CorpusState =
  | { status: "idle" }
  | { status: "ok"; message: string }
  | { status: "error"; message: string };

const VALID_INTENTS: ReadonlySet<SpanishPhraseIntent> = new Set([
  "test_drive",
  "financing",
  "trade_in",
  "general",
  "ready_to_close",
]);

const MAX_TEXT = 600; // mirrors migration 0009 check constraint.
const MAX_TAG = 60;

function asString(formData: FormData, key: string): string {
  const v = formData.get(key);
  return typeof v === "string" ? v.trim() : "";
}

export async function addSpanishPhrase(
  _prev: CorpusState,
  formData: FormData,
): Promise<CorpusState> {
  const { user } = await requireUser();
  const { dealer } = await requireDealer();

  const intentRaw = asString(formData, "intent");
  const situationTagRaw = asString(formData, "situation_tag");
  const enText = asString(formData, "en_text");
  const esText = asString(formData, "es_text");

  if (!VALID_INTENTS.has(intentRaw as SpanishPhraseIntent)) {
    return {
      status: "error",
      message: "Pick an intent (test_drive / financing / trade_in / general / ready_to_close).",
    };
  }
  if (enText.length < 1 || enText.length > MAX_TEXT) {
    return { status: "error", message: `English text must be 1–${MAX_TEXT} characters.` };
  }
  if (esText.length < 1 || esText.length > MAX_TEXT) {
    return { status: "error", message: `Spanish text must be 1–${MAX_TEXT} characters.` };
  }
  if (situationTagRaw.length > MAX_TAG) {
    return { status: "error", message: `Situation tag is too long (max ${MAX_TAG} characters).` };
  }

  const sb = await createServerSupabase();
  const { error } = await sb.from("spanish_phrases").insert({
    dealer_id: dealer.id,
    intent: intentRaw as SpanishPhraseIntent,
    situation_tag: situationTagRaw || null,
    en_text: enText,
    es_text: esText,
    created_by: user.id,
  });

  if (error) {
    log.error("spanish_corpus.insert_failed", {
      dealer_id: dealer.id,
      code: error.code,
      detail: error.message,
    });
    return {
      status: "error",
      message: "Could not save the phrase. Please try again.",
    };
  }

  revalidatePath("/dashboard/spanish-corpus");
  return { status: "ok", message: "Phrase added." };
}
