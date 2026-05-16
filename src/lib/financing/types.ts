// Financing pre-qualification provider contract (v0.7 / T1.6).
//
// The dashboard collects a soft-pull pre-qual payload and posts it to
// /api/dashboard/financing/prequal. The route calls into a provider
// adapter — RouteOne, 700Credit, or the 'none' stub — through the
// `FinancingProvider` interface defined here.
//
// SECURITY NOTE: PrequalPayload deliberately uses `ssn_last4`. The full
// 9-digit SSN MUST NEVER cross this boundary. The route handler at
// `src/app/api/dashboard/financing/prequal/route.ts` rejects requests
// containing any unbroken 9-digit run in the raw body before parsing.

export type PrequalPayload = {
  first_name: string;
  last_name: string;
  dob: string; // ISO YYYY-MM-DD
  ssn_last4: string; // exactly 4 digits — never full SSN
  address: { line1: string; city: string; state: string; zip: string };
  monthly_income: number;
  requested_amount: number;
};

// Discriminated union: providers either return a structured result
// (with provider name + status + reference_hash) OR an "unavailable"
// payload with a machine-readable reason. The route handler logs the
// whitelisted fields off this shape — see route.ts.
export type PrequalResult =
  | {
      available: true;
      provider: string;
      status: "approved" | "declined" | "pending";
      reference_hash: string;
    }
  | { available: false; reason: string };

export interface FinancingProvider {
  prequalify(payload: PrequalPayload): Promise<PrequalResult>;
}
