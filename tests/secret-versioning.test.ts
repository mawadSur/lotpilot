// v0.7.1 regression test: PREV master-secret grace window during a
// master rotation.
//
// Contract (extension.ts:122-167):
//   - verify(CURRENT) → { ok: true, usedPrev: false }
//   - if CURRENT fails AND PREV is configured AND version >= 2:
//       verify(PREV) → { ok: true, usedPrev: true }
//   - if PREV is unset → no fallback, just reject (the v0.7 default).
//   - v1 (legacy) installs are GATED OUT of the PREV path on purpose:
//     v1 shipped under exactly one master secret in the v0.6 era, so a
//     rotation can't possibly help v1; operators must bump dealers to
//     v2+ before rolling.
//
// env.ts reads MARKETPLACE_MASTER_SECRET / _PREV at module load and
// caches them in module-scoped consts (env.ts:53-62). To exercise
// different rotation states we MUST `vi.resetModules()` between cases
// and re-import the extension module — otherwise the cached env wins
// over our process.env mutation and the prev-master branch can't be
// reached (researcher hint).
//
// We sign payloads via deriveDealerSecretWithMaster(...) imported from
// the *same* freshly-reset module graph each case so the bytes match
// exactly what verifyExtensionSignature would compute internally.

import { createHmac } from "node:crypto";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const DEALER = "33333333-3333-4333-8333-333333333333";
const MASTER_NEW = "test-master-secret-new";
const MASTER_OLD = "test-master-secret-old";

async function loadExtensionModule(env: {
  current?: string;
  prev?: string;
}): Promise<typeof import("../src/lib/marketplace/extension")> {
  // Reset module cache so env.ts re-reads process.env at next import.
  vi.resetModules();

  if (env.current === undefined) delete process.env.MARKETPLACE_MASTER_SECRET;
  else process.env.MARKETPLACE_MASTER_SECRET = env.current;

  if (env.prev === undefined) delete process.env.MARKETPLACE_MASTER_SECRET_PREV;
  else process.env.MARKETPLACE_MASTER_SECRET_PREV = env.prev;

  return await import("../src/lib/marketplace/extension");
}

function hmacHex(rawBody: string, secret: string): string {
  return createHmac("sha256", secret).update(rawBody, "utf8").digest("hex");
}

describe("verifyExtensionSignature — master secret rotation (PREV grace)", () => {
  // Snapshot + restore so we don't poison sibling test files.
  const origCurrent = process.env.MARKETPLACE_MASTER_SECRET;
  const origPrev = process.env.MARKETPLACE_MASTER_SECRET_PREV;

  beforeEach(() => {
    delete process.env.MARKETPLACE_MASTER_SECRET;
    delete process.env.MARKETPLACE_MASTER_SECRET_PREV;
  });

  afterEach(() => {
    if (origCurrent === undefined) delete process.env.MARKETPLACE_MASTER_SECRET;
    else process.env.MARKETPLACE_MASTER_SECRET = origCurrent;
    if (origPrev === undefined) delete process.env.MARKETPLACE_MASTER_SECRET_PREV;
    else process.env.MARKETPLACE_MASTER_SECRET_PREV = origPrev;
    vi.resetModules();
  });

  it("v2 sig keyed on PREV master verifies and returns usedPrev=true", async () => {
    // Rotation state: CURRENT='new' AND PREV='old' both configured.
    // Dealer's extension binary was minted under old master and hasn't
    // been re-issued yet. Inbound must accept, with usedPrev=true so
    // the route writes a `marketplace_secret_rotated` warning.
    const mod = await loadExtensionModule({ current: MASTER_NEW, prev: MASTER_OLD });

    const body = JSON.stringify({
      dealer_id: DEALER,
      marketplace_thread_id: "thr_old_install",
      buyer_name: "Buyer",
      buyer_message: "from a stale binary",
    });
    const prevDealerSecret = mod.deriveDealerSecretWithMaster(DEALER, 2, MASTER_OLD);
    const signature = hmacHex(body, prevDealerSecret);

    const result = mod.verifyExtensionSignature({
      rawBody: body,
      signature,
      dealerId: DEALER,
      version: 2,
    });

    expect(result).toEqual({ ok: true, usedPrev: true });
  });

  it("v2 sig keyed on CURRENT master returns usedPrev=false even with PREV configured", async () => {
    // Same rotation state, but the dealer already re-issued the binary
    // and is signing under CURRENT. PREV must NOT short-circuit the
    // happy path or we'd write a spurious warning on every inbound.
    const mod = await loadExtensionModule({ current: MASTER_NEW, prev: MASTER_OLD });

    const body = JSON.stringify({
      dealer_id: DEALER,
      marketplace_thread_id: "thr_fresh_install",
      buyer_name: "Buyer",
      buyer_message: "from a fresh binary",
    });
    const currentDealerSecret = mod.deriveDealerSecretWithMaster(DEALER, 2, MASTER_NEW);
    const signature = hmacHex(body, currentDealerSecret);

    const result = mod.verifyExtensionSignature({
      rawBody: body,
      signature,
      dealerId: DEALER,
      version: 2,
    });

    expect(result).toEqual({ ok: true, usedPrev: false });
  });

  it("rejects PREV-signed payload once PREV is cleared (rotation completed)", async () => {
    // Operator finished the rotation: PREV is cleared. The same stale
    // binary that was grandfathered through in case #1 must now be
    // rejected (403 in the route handler). This is the regression
    // guard: if extension.ts ever falls back to deriving against
    // anything other than the configured masters, this fails.
    //
    // First build the PREV-keyed signature *while* PREV is still set
    // so we get the exact bytes a stale binary would emit. (We can do
    // this without loading the verifier at all — deriveDealerSecretWithMaster
    // is master-explicit, so no env state is read by it.)
    const modWithPrev = await loadExtensionModule({ current: MASTER_NEW, prev: MASTER_OLD });
    const prevDealerSecret = modWithPrev.deriveDealerSecretWithMaster(DEALER, 2, MASTER_OLD);
    const body = JSON.stringify({
      dealer_id: DEALER,
      marketplace_thread_id: "thr_replay",
      buyer_name: "Buyer",
      buyer_message: "stale-binary replay after rotation completed",
    });
    const signature = hmacHex(body, prevDealerSecret);

    // Now reload with PREV cleared and run verify.
    const modAfterRotation = await loadExtensionModule({ current: MASTER_NEW, prev: undefined });
    const result = modAfterRotation.verifyExtensionSignature({
      rawBody: body,
      signature,
      dealerId: DEALER,
      version: 2,
    });

    expect(result).toEqual({ ok: false, usedPrev: false });
  });

  it("v1 (legacy) signatures are NOT eligible for the PREV grace path", async () => {
    // The PREV branch is gated to version >= 2 at extension.ts:152 on
    // purpose: v1 shipped under exactly one master in v0.6, so a
    // rotation can't possibly help — and allowing PREV at v1 would
    // open a downgrade attack (force version=1 to dodge the v2+ gate).
    //
    // Sign with PREV at v1, expect rejection even though PREV is
    // configured.
    const mod = await loadExtensionModule({ current: MASTER_NEW, prev: MASTER_OLD });

    const body = JSON.stringify({
      dealer_id: DEALER,
      marketplace_thread_id: "thr_v1_downgrade_attempt",
      buyer_name: "Buyer",
      buyer_message: "v1 against prev master",
    });
    const prevDealerSecretV1 = mod.deriveDealerSecretWithMaster(DEALER, 1, MASTER_OLD);
    const signature = hmacHex(body, prevDealerSecretV1);

    const result = mod.verifyExtensionSignature({
      rawBody: body,
      signature,
      dealerId: DEALER,
      version: 1,
    });

    expect(result).toEqual({ ok: false, usedPrev: false });
  });
});
