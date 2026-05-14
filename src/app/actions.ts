"use server";

import { headers } from "next/headers";
import { createServerSupabase } from "@/lib/supabase-server";
import { supabaseAuthConfigured } from "@/lib/env";

export type SignupState =
  | { status: "idle" }
  | { status: "ok"; dealership: string }
  | { status: "error"; message: string };

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
const VALID_CHANNELS = new Set([
  "marketplace",
  "autotrader",
  "cars_com",
  "website",
  "walk_in",
  "other",
]);

function str(formData: FormData, key: string): string {
  const v = formData.get(key);
  return typeof v === "string" ? v.trim() : "";
}

export async function submitSignup(
  _prev: SignupState,
  formData: FormData,
): Promise<SignupState> {
  const dealership = str(formData, "dealership_name");
  const contact = str(formData, "contact_name");
  const email = str(formData, "email");
  const phone = str(formData, "phone") || null;
  const inventoryRaw = str(formData, "inventory_size");
  const channel = str(formData, "primary_channel") || null;
  const notes = str(formData, "notes") || null;

  if (!dealership || dealership.length > 200) {
    return { status: "error", message: "Dealership name is required." };
  }
  if (!contact || contact.length > 120) {
    return { status: "error", message: "Your name is required." };
  }
  if (!EMAIL_RE.test(email) || email.length > 254) {
    return { status: "error", message: "Enter a valid email address." };
  }
  if (phone && (phone.length < 7 || phone.length > 30)) {
    return { status: "error", message: "Phone number looks invalid." };
  }

  let inventory: number | null = null;
  if (inventoryRaw) {
    const n = Number(inventoryRaw);
    if (!Number.isInteger(n) || n < 1 || n > 10000) {
      return { status: "error", message: "Inventory size must be 1–10000." };
    }
    inventory = n;
  }
  if (channel && !VALID_CHANNELS.has(channel)) {
    return { status: "error", message: "Pick a valid channel." };
  }
  if (notes && notes.length > 2000) {
    return { status: "error", message: "Notes are too long (max 2000)." };
  }

  if (!supabaseAuthConfigured) {
    // Graceful fallback: the site still demos without Supabase wired up.
    // The README explains how to enable real persistence.
    return { status: "ok", dealership };
  }

  const sb = await createServerSupabase();
  const ua = (await headers()).get("user-agent")?.slice(0, 500) ?? null;

  const payload = {
    dealership_name: dealership,
    contact_name: contact,
    email,
    phone,
    inventory_size: inventory,
    primary_channel: channel,
    notes,
    user_agent: ua,
  } satisfies {
    dealership_name: string;
    contact_name: string;
    email: string;
    phone: string | null;
    inventory_size: number | null;
    primary_channel: string | null;
    notes: string | null;
    user_agent: string | null;
  };

  const { error } = await sb.from("dealer_signups").insert(payload);

  if (error) {
    return {
      status: "error",
      message: "Could not save signup. Please try again.",
    };
  }
  return { status: "ok", dealership };
}
