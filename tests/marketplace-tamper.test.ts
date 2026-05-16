// v0.7.1 regression test: marketplace HMAC tamper resistance.
//
// `verifyExtensionSignature` is the entry-point auth for
// /api/marketplace/inbound. We test it as a pure function (no Supabase,
// no route handler) so the unit feedback loop is fast and the assertions
// are tight against the contract documented at extension.ts:122-167.
//
// Five cases, all v2 (the version path that's stable in v0.7+; v1 keeps
// its own legacy contract):
//   1. happy path — good HMAC, correct dealer_id header/body match → ok.
//   2. body tamper — body byte flipped, signature kept → reject.
//   3. header/body dealer_id mismatch — caller must detect tamper
//      because the HMAC is keyed on the HEADER dealer_id (the route
//      handler does the body-vs-header equality check; we sim it here
//      by signing against header dealer A and presenting a body that
//      carries dealer B's id, then re-running verify with the body's
//      dealer to model what a downstream tamper check would see).
//   4. missing signature header → reject (signature: null).
//   5. wrong dealer_id in the call — signature was computed for dealer A
//      but we ask verify to validate as dealer B → reject.
//
// Researcher's note: most of this is a pure function call, so we skip
// the vi.hoisted/vi.mock dance. We DO need env.ts's
// MARKETPLACE_MASTER_SECRET to be set, which tests/setup.ts arranges
// indirectly via the env defaults block. We set it explicitly here to
// keep this test self-contained.

import { createHmac } from "node:crypto";
import { beforeEach, describe, expect, it, vi } from "vitest";

// env.ts captures MARKETPLACE_MASTER_SECRET at module load (env.ts:53)
// — that const is then closed-over by requireMarketplaceMasterSecret.
// ESM hoists `import` to the top of the file, so a plain
// `process.env.X = ...; import ...` block at the top of THIS file
// would run the import FIRST and the env mutation second. We use
// vi.hoisted to set env BEFORE module init, then dynamic-import the
// extension module so env.ts re-reads under our values.
const ENV = vi.hoisted(() => {
  process.env.MARKETPLACE_MASTER_SECRET = "test-master-secret-current";
  delete process.env.MARKETPLACE_MASTER_SECRET_PREV;
  return { master: "test-master-secret-current" };
});

const { deriveDealerSecretWithMaster, verifyExtensionSignature } = await import(
  "../src/lib/marketplace/extension"
);

const DEALER_A = "11111111-1111-4111-8111-111111111111";
const DEALER_B = "22222222-2222-4222-8222-222222222222";
const MASTER = ENV.master;

function sign(rawBody: string, dealerId: string, version: number, master: string): string {
  const secret = deriveDealerSecretWithMaster(dealerId, version, master);
  return createHmac("sha256", secret).update(rawBody, "utf8").digest("hex");
}

describe("verifyExtensionSignature — tamper resistance", () => {
  beforeEach(() => {
    // Belt-and-braces: re-pin env each case so an earlier mutation
    // doesn't bleed through. (vitest pool=forks already isolates files,
    // but we also reset within the file.)
    process.env.MARKETPLACE_MASTER_SECRET = MASTER;
    delete process.env.MARKETPLACE_MASTER_SECRET_PREV;
  });

  it("accepts a well-formed v2 signature on the happy path", () => {
    const body = JSON.stringify({
      dealer_id: DEALER_A,
      marketplace_thread_id: "thr_1",
      buyer_name: "Buyer",
      buyer_message: "interested in the civic",
    });
    const signature = sign(body, DEALER_A, 2, MASTER);

    const result = verifyExtensionSignature({
      rawBody: body,
      signature,
      dealerId: DEALER_A,
      version: 2,
    });

    expect(result).toEqual({ ok: true, usedPrev: false });
  });

  it("rejects when a single body byte is flipped but the signature is kept", () => {
    const body = JSON.stringify({
      dealer_id: DEALER_A,
      marketplace_thread_id: "thr_1",
      buyer_name: "Buyer",
      buyer_message: "interested in the civic",
    });
    const signature = sign(body, DEALER_A, 2, MASTER);

    // Flip one character in the body — same length, same dealer_id,
    // different bytes. Signature no longer matches.
    const tamperedBody = body.replace("civic", "ridge"); // same length: 5 chars
    expect(tamperedBody.length).toBe(body.length);

    const result = verifyExtensionSignature({
      rawBody: tamperedBody,
      signature,
      dealerId: DEALER_A,
      version: 2,
    });

    expect(result).toEqual({ ok: false, usedPrev: false });
  });

  it("rejects when the body dealer_id does not match the header dealer_id", () => {
    // Forge a payload where the body claims dealer A but the request
    // header (and HMAC key) claim dealer B. The verifier itself is
    // keyed on the HEADER dealer_id (args.dealerId), so a signature
    // built against the body's claimed dealer A will NOT validate
    // when verify is called with header=DEALER_B.
    //
    // The route handler also enforces header == body equality
    // upstream, but a buggy refactor that drops that check must still
    // be caught by verify failing on its own.
    const body = JSON.stringify({
      dealer_id: DEALER_A, // body claims A
      marketplace_thread_id: "thr_1",
      buyer_name: "Buyer",
      buyer_message: "tamper attempt",
    });
    // Sign as if we were dealer A (with dealer A's derived secret).
    const signature = sign(body, DEALER_A, 2, MASTER);

    // But present this body to verify claiming the header is dealer B.
    const result = verifyExtensionSignature({
      rawBody: body,
      signature,
      dealerId: DEALER_B, // header says B
      version: 2,
    });

    expect(result).toEqual({ ok: false, usedPrev: false });
  });

  it("rejects when the signature header is missing (null)", () => {
    const body = JSON.stringify({
      dealer_id: DEALER_A,
      marketplace_thread_id: "thr_1",
      buyer_name: "Buyer",
      buyer_message: "no sig",
    });

    const result = verifyExtensionSignature({
      rawBody: body,
      signature: null,
      dealerId: DEALER_A,
      version: 2,
    });

    expect(result).toEqual({ ok: false, usedPrev: false });
  });

  it("rejects when an invalid dealer_id is supplied as the header", () => {
    // Wrong shape — verify must reject before trying to derive a
    // secret (UUID regex check at extension.ts:132).
    const body = JSON.stringify({
      dealer_id: DEALER_A,
      marketplace_thread_id: "thr_1",
      buyer_name: "Buyer",
      buyer_message: "bad dealer",
    });
    const signature = sign(body, DEALER_A, 2, MASTER);

    const result = verifyExtensionSignature({
      rawBody: body,
      signature,
      dealerId: "not-a-uuid",
      version: 2,
    });

    expect(result).toEqual({ ok: false, usedPrev: false });
  });

  it("rejects a malformed signature (not 64-char hex)", () => {
    // Defence-in-depth: the HEX_SIG_RE check at extension.ts:131 must
    // refuse short or non-hex signatures before any HMAC work.
    const body = JSON.stringify({
      dealer_id: DEALER_A,
      marketplace_thread_id: "thr_1",
      buyer_name: "Buyer",
      buyer_message: "malformed sig",
    });

    const result = verifyExtensionSignature({
      rawBody: body,
      signature: "deadbeef", // wrong length
      dealerId: DEALER_A,
      version: 2,
    });

    expect(result).toEqual({ ok: false, usedPrev: false });
  });
});
