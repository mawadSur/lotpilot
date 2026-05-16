// "None" financing provider — the default when FINANCING_PROVIDER is
// unset or unrecognised. Returns a stable { available: false } so the
// dashboard can render a "financing not configured" state without
// throwing.
//
// Mirrors the trade-in T1.5 stub posture: no network, no env required.

import type { FinancingProvider, PrequalResult } from "./types";

export const noneProvider: FinancingProvider = {
  async prequalify(): Promise<PrequalResult> {
    return { available: false, reason: "financing_disabled" };
  },
};
