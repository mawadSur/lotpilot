// Buyer-session cookie helpers, used by the public chat widget at /c/[slug].
//
// We persist a 32-byte hex random token in `lp_session` so the same browser
// keeps the same conversation across reloads and across vehicles within the
// same dealership. The cookie is httpOnly + secure + sameSite=lax + 30 days.
//
// The cookie is also echoed in an `x-buyer-session` request header by the
// chat widget so RLS policies that scope by header value match.

import { cookies } from "next/headers";
import { randomBytes } from "node:crypto";

const COOKIE_NAME = "lp_session";
const MAX_AGE_SECONDS = 60 * 60 * 24 * 30; // 30 days

export const BUYER_SESSION_COOKIE = COOKIE_NAME;

export function newBuyerSession(): string {
  return randomBytes(32).toString("hex");
}

export function isValidBuyerSession(value: string | undefined | null): value is string {
  if (typeof value !== "string") return false;
  if (value.length < 16 || value.length > 128) return false;
  return /^[a-f0-9]+$/i.test(value);
}

export async function readBuyerSession(): Promise<string | null> {
  const store = await cookies();
  const v = store.get(COOKIE_NAME)?.value;
  return isValidBuyerSession(v) ? v : null;
}

// Read the buyer session, minting + persisting one if it doesn't yet exist.
// Cookie writes only succeed inside Server Actions / Route Handlers — in a
// Server Component the new cookie is returned but not actually set; the
// route handler that follows the buyer's first message will set it.
export async function readOrCreateBuyerSession(): Promise<{
  session: string;
  isNew: boolean;
}> {
  const existing = await readBuyerSession();
  if (existing) return { session: existing, isNew: false };
  const fresh = newBuyerSession();
  try {
    const store = await cookies();
    store.set(COOKIE_NAME, fresh, {
      httpOnly: true,
      sameSite: "lax",
      secure: process.env.NODE_ENV === "production",
      path: "/",
      maxAge: MAX_AGE_SECONDS,
    });
  } catch {
    // Cookies cannot be set during a Server Component render. The next
    // route-handler call will persist it.
  }
  return { session: fresh, isNew: true };
}

// Used by the /api/chat route handler, which always runs in a context that
// allows cookie writes.
export async function persistBuyerSession(value: string): Promise<void> {
  const store = await cookies();
  store.set(COOKIE_NAME, value, {
    httpOnly: true,
    sameSite: "lax",
    secure: process.env.NODE_ENV === "production",
    path: "/",
    maxAge: MAX_AGE_SECONDS,
  });
}
