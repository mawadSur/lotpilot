// RouteOne financing provider stub (v0.7 / T1.6).
//
// API contract is still pending with RouteOne — until we have it, this
// module only does the env-presence check. With creds absent the
// dispatcher returns a clean { available: false, reason } so the
// dashboard renders the disabled state. With creds present we throw —
// loudly — so a misconfigured deploy can't silently swallow pre-qual
// requests. Wiring the actual fetch is v0.7.2.

import { routeOneConfigured } from "@/lib/env";
import type { FinancingProvider, PrequalResult } from "./types";

export const routeOneProvider: FinancingProvider = {
  async prequalify(): Promise<PrequalResult> {
    if (!routeOneConfigured) {
      return { available: false, reason: "route_one_not_configured" };
    }
    // Creds present but the real call isn't built yet. Throw so the
    // route handler's try/catch promotes this to a 500 with a generic
    // body (no detail leak) and an error-level log.
    throw new Error("TODO: pending API contract");
  },
};
