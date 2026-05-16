// Dispatcher for the trade-in valuation providers. Single entry point
// for callers (the dashboard route, eventually the chat pipeline) so
// the env-keyed provider selection stays in one place.
//
// The kbb / manheim providers are loaded lazily via dynamic import so
// the "none" path doesn't pay the parse cost on a cold lambda. Cold
// start matters here: the eventual chat pipeline may call this from
// inside a buyer message, and an unnecessary 7.5MB of provider code
// (mirroring why `voice/vapi.ts:6-20` dropped the @vapi-ai SDK) on
// every cold start would push p99 over our 2s ceiling.
//
// `tradeInProvider` is imported as a const value, NOT called as a
// function — it's a module-load-time resolved string in env.ts.

import { tradeInProvider } from "@/lib/env";
import { noneProvider } from "./none";
import type { TradeInPayload, TradeInResult } from "./types";

export async function valueVehicle(payload: TradeInPayload): Promise<TradeInResult> {
  if (tradeInProvider === "none") {
    return noneProvider.value(payload);
  }
  if (tradeInProvider === "kbb") {
    const { kbbProvider } = await import("./kbb");
    return kbbProvider.value(payload);
  }
  if (tradeInProvider === "manheim") {
    const { manheimProvider } = await import("./manheim");
    return manheimProvider.value(payload);
  }
  // Belt-and-braces — the TradeInProviderName type only allows the
  // three branches above, but if env.ts is ever extended without
  // updating this dispatcher we want a stable shape rather than a
  // crash.
  return { available: false, reason: "unknown_provider" };
}

export type { TradeInPayload, TradeInResult } from "./types";
