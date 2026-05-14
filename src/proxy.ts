// Refreshes the Supabase auth session on every dashboard / auth navigation
// so server components see a valid token. Next.js 16 renamed the
// "middleware" file convention to "proxy"; the function still acts as
// pre-rendering middleware.
//
// Skips marketing routes, static assets, the public chat widget, and the
// chat API.

import { createServerClient } from "@supabase/ssr";
import { NextResponse, type NextRequest } from "next/server";
import { requireAuthEnv, supabaseAuthConfigured } from "@/lib/env";

const PROTECTED_PREFIXES = ["/dashboard"];
const AUTH_PREFIXES = ["/login", "/auth"];

export async function proxy(request: NextRequest) {
  const { pathname } = request.nextUrl;
  const isProtected = PROTECTED_PREFIXES.some((p) => pathname.startsWith(p));
  const isAuth = AUTH_PREFIXES.some((p) => pathname.startsWith(p));

  if (!isProtected && !isAuth) {
    return NextResponse.next();
  }
  if (!supabaseAuthConfigured) {
    return NextResponse.next();
  }

  let response = NextResponse.next({ request });
  const { url, anonKey } = requireAuthEnv();
  const supabase = createServerClient(url, anonKey, {
    cookies: {
      getAll() {
        return request.cookies.getAll().map((c) => ({ name: c.name, value: c.value }));
      },
      setAll(cookiesToSet) {
        for (const { name, value } of cookiesToSet) {
          request.cookies.set(name, value);
        }
        response = NextResponse.next({ request });
        for (const { name, value, options } of cookiesToSet) {
          response.cookies.set(name, value, options);
        }
      },
    },
  });

  const { data: userRes } = await supabase.auth.getUser();

  if (isProtected && !userRes.user) {
    const url = request.nextUrl.clone();
    url.pathname = "/login";
    url.searchParams.set("next", pathname);
    return NextResponse.redirect(url);
  }

  return response;
}

export const config = {
  // Run on the auth + dashboard surface. Skip static assets, the chat API,
  // the public chat widget, and the marketing landing page.
  matcher: [
    "/dashboard/:path*",
    "/login",
    "/auth/:path*",
  ],
};
