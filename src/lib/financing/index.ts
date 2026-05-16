// Financing provider dispatcher (v0.7 / T1.6).
//
// Reads `financingProvider()` from env and lazy-imports the matching
// adapter. Lazy so a deploy that only ever uses 'none' doesn't pull in
// the RouteOne/700Credit modules (small, but the discipline matters
// when those modules eventually have heavier deps like an SDK).
//
// Symmetric with the trade-in dispatcher pattern.

import { financingProvider } from "@/lib/env";
import type { FinancingProvider, PrequalPayload, PrequalResult } from "./types";

async function loadProvider(): Promise<FinancingProvider> {
  const name = financingProvider;
  if (name === "route_one") {
    const mod = await import("./route_one");
    return mod.routeOneProvider;
  }
  if (name === "seven_hundred_credit") {
    const mod = await import("./seven_hundred_credit");
    return mod.sevenHundredCreditProvider;
  }
  const mod = await import("./none");
  return mod.noneProvider;
}

export async function prequalify(payload: PrequalPayload): Promise<PrequalResult> {
  const provider = await loadProvider();
  return provider.prequalify(payload);
}

export type { PrequalPayload, PrequalResult, FinancingProvider } from "./types";
