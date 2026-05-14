"use server";

import { revalidatePath } from "next/cache";
import { requireDealer } from "@/lib/auth";
import { createServerSupabase } from "@/lib/supabase-server";
import { log } from "@/lib/log";
import type { BusinessHoursMap } from "@/lib/db-types";

export type SettingsState =
  | { status: "idle" }
  | { status: "ok"; message: string }
  | { status: "error"; message: string };

const CALENDLY_RE = /^https:\/\/(www\.)?calendly\.com\//;
const TIME_RE = /^([01]\d|2[0-3]):[0-5]\d$/;
const E164_RE = /^\+[1-9][0-9]{7,14}$/;

const VALID_TIMEZONES: ReadonlySet<string> = new Set([
  "America/New_York",
  "America/Chicago",
  "America/Denver",
  "America/Phoenix",
  "America/Los_Angeles",
  "America/Anchorage",
  "Pacific/Honolulu",
  "America/Puerto_Rico",
]);

const DAYS: (keyof BusinessHoursMap)[] = ["mon", "tue", "wed", "thu", "fri", "sat", "sun"];

function readHours(formData: FormData): BusinessHoursMap | null {
  const out: Partial<BusinessHoursMap> = {};
  for (const day of DAYS) {
    const closed = formData.get(`hours_${day}_closed`);
    if (closed === "on") {
      out[day] = null;
      continue;
    }
    const open = formData.get(`hours_${day}_open`);
    const close = formData.get(`hours_${day}_close`);
    if (typeof open !== "string" || typeof close !== "string") return null;
    if (!TIME_RE.test(open) || !TIME_RE.test(close)) return null;
    if (open >= close) return null;
    out[day] = [open, close];
  }
  return out as BusinessHoursMap;
}

function asString(formData: FormData, key: string): string {
  const v = formData.get(key);
  return typeof v === "string" ? v.trim() : "";
}

export async function updateSettings(
  _prev: SettingsState,
  formData: FormData,
): Promise<SettingsState> {
  const { dealer } = await requireDealer();

  const name = asString(formData, "name");
  const signature = asString(formData, "signature");
  const calendlyRaw = asString(formData, "calendly_url");
  const timezone = asString(formData, "timezone") || dealer.timezone;
  const smsRaw = asString(formData, "sms_number");
  const voiceRaw = asString(formData, "voice_number");
  const whatsappRaw = asString(formData, "whatsapp_number");
  const approveBeforeSend = formData.get("approve_before_send") === "on";

  if (name.length < 2 || name.length > 200) {
    return { status: "error", message: "Dealership name is required (2–200 chars)." };
  }
  if (signature.length > 500) {
    return { status: "error", message: "Signature is too long (max 500 chars)." };
  }
  if (calendlyRaw && !CALENDLY_RE.test(calendlyRaw)) {
    return { status: "error", message: "Calendly URL must start with https://calendly.com/." };
  }
  if (!VALID_TIMEZONES.has(timezone)) {
    return { status: "error", message: "Pick a supported time zone." };
  }
  if (smsRaw && !E164_RE.test(smsRaw)) {
    return {
      status: "error",
      message: "SMS number must be in E.164 format (e.g. +14155551212).",
    };
  }
  if (voiceRaw && !E164_RE.test(voiceRaw)) {
    return {
      status: "error",
      message: "Voice number must be in E.164 format (e.g. +14155551212).",
    };
  }
  if (whatsappRaw && !E164_RE.test(whatsappRaw)) {
    return {
      status: "error",
      message: "WhatsApp number must be in E.164 format (e.g. +14155551212).",
    };
  }

  const hours = readHours(formData);
  if (!hours) {
    return { status: "error", message: "Business hours are invalid. Open must be earlier than close." };
  }

  const sb = await createServerSupabase();
  const { error } = await sb
    .from("dealers")
    .update({
      name,
      signature: signature || null,
      business_hours: hours,
      calendly_url: calendlyRaw || null,
      timezone,
      sms_number: smsRaw || null,
      voice_number: voiceRaw || null,
      whatsapp_number: whatsappRaw || null,
      approve_before_send: approveBeforeSend,
    })
    .eq("id", dealer.id);

  if (error) {
    log.error("settings.update_failed", {
      dealer_id: dealer.id,
      code: error.code,
      detail: error.message,
    });
    return { status: "error", message: "Could not save settings. Please try again." };
  }

  revalidatePath("/dashboard/settings");
  revalidatePath("/dashboard");
  return { status: "ok", message: "Saved." };
}
