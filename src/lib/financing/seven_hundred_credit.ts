// 700Credit financing provider stub (v0.7 / T1.6).
//
// Symmetric with route_one.ts — env-presence check, then throw if creds
// present. Wiring the actual fetch is v0.7.2.

import { sevenHundredCreditConfigured } from "@/lib/env";
import type { FinancingProvider, PrequalResult } from "./types";

export const sevenHundredCreditProvider: FinancingProvider = {
  async prequalify(): Promise<PrequalResult> {
    if (!sevenHundredCreditConfigured) {
      return { available: false, reason: "seven_hundred_credit_not_configured" };
    }
    throw new Error("TODO: pending API contract");
  },
};
