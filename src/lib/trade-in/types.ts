// Trade-in valuation contract. Three concrete providers exist behind
// the dispatcher in `./index.ts`:
//   - none    → always { available: false, reason: "valuation_disabled" }
//   - kbb     → Kelley Blue Book Vehicle Values API (primary)
//   - manheim → Manheim MMR (wholesale; scaffolded, contract pending)
//
// The result discriminator is `available`. Callers that want a price
// should narrow on `available === true` before reading the low/mid/high
// fields. The "half-configured = available:false" posture (mirror of
// `src/lib/whatsapp/cloud-api.ts:217-220`) lets the route handler call
// the dispatcher unconditionally and not branch on env presence.

export type TradeInCondition = "excellent" | "good" | "fair" | "poor";

export type TradeInPayload = {
  vin?: string;
  year: number;
  make: string;
  model: string;
  mileage: number;
  condition: TradeInCondition;
  zip: string;
};

export type TradeInResult =
  | {
      available: true;
      provider: string;
      low_usd: number;
      mid_usd: number;
      high_usd: number;
    }
  | { available: false; reason: string };

export interface TradeInProvider {
  value(payload: TradeInPayload): Promise<TradeInResult>;
}
