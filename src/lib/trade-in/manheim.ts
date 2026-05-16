// Manheim MMR adapter. v0.7.1 scaffold: Manheim's developer portal
// requires a signed dealer agreement before they hand over the API
// spec, so this provider deliberately throws once it gets past the
// half-configured guard. The dispatcher in `./index.ts` already knows
// how to reach this provider; the route handler returns
// `provider_unavailable` on the throw.
//
// What IS implemented:
//   - manheimConfigured() guard — half-configured deploys return
//     { available:false, reason:"manheim_not_configured" }, mirroring
//     `src/lib/whatsapp/cloud-api.ts:217-220`.
//   - AbortController + per-attempt timeout (mirror of
//     `src/lib/voice/vapi.ts:91-169`).
//
// What is NOT:
//   - OAuth client-credentials exchange (Manheim's docs hint at a
//     token endpoint; both client id + secret are read from env).
//   - The MMR response shape (wholesale "low/avg/high" by region).

import { manheimConfigured, readManheimCreds } from "@/lib/env";
import { log } from "@/lib/log";
import type { TradeInPayload, TradeInProvider, TradeInResult } from "./types";

const MANHEIM_API_HOST = "https://api.manheim.com";
const TIMEOUT_MS = 5000;

export class ManheimProvider implements TradeInProvider {
  readonly name = "manheim";

  async value(payload: TradeInPayload): Promise<TradeInResult> {
    if (!manheimConfigured) {
      log.info("tradein.manheim.not_configured", {});
      return { available: false, reason: "manheim_not_configured" };
    }
    const creds = readManheimCreds();
    if (!creds) {
      return { available: false, reason: "manheim_not_configured" };
    }

    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), TIMEOUT_MS);
    try {
      // TODO(v0.7.2): exchange creds for a bearer, then POST to
      //   `${MANHEIM_API_HOST}/valuations/v1/mmr`. Reference the host
      //   + payload below so strict-mode + eslint keep them live.
      void MANHEIM_API_HOST;
      void creds;
      void payload;
      throw new Error("TODO: pending Manheim API contract");
    } finally {
      clearTimeout(timer);
    }
  }
}

export const manheimProvider = new ManheimProvider();
