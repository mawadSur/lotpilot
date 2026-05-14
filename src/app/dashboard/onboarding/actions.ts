"use server";

import { redirect } from "next/navigation";
import { revalidatePath } from "next/cache";
import { requireUserMaybeDealer } from "@/lib/auth";
import { createServerSupabase } from "@/lib/supabase-server";
import type { BusinessHoursMap } from "@/lib/db-types";

export type OnboardingState =
  | { status: "idle" }
  | { status: "error"; message: string }
  | { status: "ok"; slug: string };

const SLUG_RE = /^[a-z0-9](?:[a-z0-9-]{1,38}[a-z0-9])?$/;
const CALENDLY_RE = /^https:\/\/(www\.)?calendly\.com\//;
const TIME_RE = /^([01]\d|2[0-3]):[0-5]\d$/;
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

const DEFAULT_HOURS: BusinessHoursMap = {
  mon: ["09:00", "19:00"],
  tue: ["09:00", "19:00"],
  wed: ["09:00", "19:00"],
  thu: ["09:00", "19:00"],
  fri: ["09:00", "19:00"],
  sat: ["10:00", "18:00"],
  sun: null,
};

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

export async function completeOnboarding(
  _prev: OnboardingState,
  formData: FormData,
): Promise<OnboardingState> {
  const { user, dealer } = await requireUserMaybeDealer();
  if (dealer) {
    // Already onboarded — nothing to do.
    redirect("/dashboard");
  }

  const name = asString(formData, "name");
  const slug = asString(formData, "slug").toLowerCase();
  const signature = asString(formData, "signature");
  const calendlyRaw = asString(formData, "calendly_url");
  const timezone = asString(formData, "timezone") || "America/New_York";

  if (name.length < 2 || name.length > 200) {
    return { status: "error", message: "Dealership name is required (2–200 chars)." };
  }
  if (!SLUG_RE.test(slug)) {
    return {
      status: "error",
      message:
        "Slug must be 3–40 lowercase letters, numbers, or hyphens. Example: atlanta-auto-mart.",
    };
  }
  if (signature.length > 500) {
    return { status: "error", message: "Signature is too long (max 500 chars)." };
  }
  if (calendlyRaw && !CALENDLY_RE.test(calendlyRaw)) {
    return {
      status: "error",
      message: "Calendly URL must start with https://calendly.com/.",
    };
  }
  if (!VALID_TIMEZONES.has(timezone)) {
    return { status: "error", message: "Pick a supported time zone." };
  }

  const hours = readHours(formData) ?? DEFAULT_HOURS;

  const sb = await createServerSupabase();

  // Slug uniqueness check up front so we can give a friendly error rather
  // than a Postgres conflict.
  const slugCheck = await sb.from("dealers").select("id").eq("slug", slug).maybeSingle();
  if (slugCheck.data) {
    return {
      status: "error",
      message: "That URL is already taken. Try another.",
    };
  }

  const insertRes = await sb.from("dealers").insert({
    owner_user_id: user.id,
    slug,
    name,
    signature: signature || null,
    business_hours: hours,
    calendly_url: calendlyRaw || null,
    timezone,
    onboarded_at: new Date().toISOString(),
  });

  if (insertRes.error) {
    return {
      status: "error",
      message: "Could not save your dealership. Please try again.",
    };
  }

  revalidatePath("/dashboard");
  redirect("/dashboard");
}
