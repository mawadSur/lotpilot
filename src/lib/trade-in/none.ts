// The "off" provider. Selected when TRADE_IN_PROVIDER is unset or set
// to "none" — every call resolves to a stable `{ available: false }`
// payload so callers can render a "valuation unavailable" UI without
// branching on env. Mirrors the disabled-path in
// `src/lib/whatsapp/cloud-api.ts:217-220`.

import type { TradeInProvider } from "./types";

export const noneProvider: TradeInProvider = {
  async value() {
    return { available: false, reason: "valuation_disabled" };
  },
};
