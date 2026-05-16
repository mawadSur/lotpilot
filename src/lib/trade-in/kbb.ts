// Kelley Blue Book adapter. v0.7.1 scaffold: the API contract isn't
// finalised yet (KBB's Vehicle Values API has gated, NDA'd docs), so
// `value()` deliberately throws once it gets past the half-configured
// guard. The dispatcher in `./index.ts` is wired up; the route handler
// catches and returns `provider_unavailable` so the dealer sees a
// stable error envelope rather than a 500 stack trace.
//
// What IS implemented:
//   - kbbConfigured() guard — half-configured deploys return
//     { available:false, reason:"kbb_not_configured" }, mirroring the
//     posture in `src/lib/whatsapp/cloud-api.ts:217-220`.
//   - AbortController + per-attempt timeout (mirror of
//     `src/lib/voice/vapi.ts:91-169`) so when we DO wire up the live
//     fetch in v0.7.2, the request shape is already production-ready
//     and won't hang a lambda on a slow KBB upstream.
//
// What is NOT:
//   - The actual POST body. KBB returns a Trade-In Value object with
//     "vehicleId" / "valuesByCondition" — schema TBD per their final
//     API spec.

import { kbbConfigured, readKbbApiKey } from "@/lib/env";
import { log } from "@/lib/log";
import type { TradeInPayload, TradeInProvider, TradeInResult } from "./types";

const KBB_API_HOST = "https://api.kbb.com";
const TIMEOUT_MS = 5000;

export class KbbProvider implements TradeInProvider {
  readonly name = "kbb";

  async value(payload: TradeInPayload): Promise<TradeInResult> {
    if (!kbbConfigured) {
      log.info("tradein.kbb.not_configured", {});
      return { available: false, reason: "kbb_not_configured" };
    }
    const apiKey = readKbbApiKey();
    if (!apiKey) {
      // Defensive: kbbConfigured was true at module load but the
      // reader returned null. Treat as misconfigured.
      return { available: false, reason: "kbb_not_configured" };
    }

    // Production-ready request shape — wired up to the eventual KBB
    // endpoint in v0.7.2. We build the controller + timer now so the
    // structure is identical when the throw is replaced with a fetch.
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), TIMEOUT_MS);
    try {
      // TODO(v0.7.2): replace with KBB Vehicle Values fetch.
      //   const url = `${KBB_API_HOST}/v1/valuations/trade-in`;
      //   const res = await fetch(url, {
      //     method: "POST",
      //     signal: controller.signal,
      //     headers: { Authorization: `Bearer ${apiKey}`, ... },
      //     body: JSON.stringify({ vin, year, make, model, mileage, ... }),
      //   });
      // For now the host + payload shape are intentionally referenced
      // so the eventual diff is small and the eslint no-unused-vars
      // rule doesn't fire under strict mode.
      void KBB_API_HOST;
      void payload;
      throw new Error("TODO: pending KBB API contract");
    } finally {
      clearTimeout(timer);
    }
  }
}

export const kbbProvider = new KbbProvider();
