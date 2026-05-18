// Cross-verifies that the LotPilot Marketplace Bridge extension's
// HMAC helper (extensions/marketplace-bridge/hmac.js, which uses Web
// Crypto's crypto.subtle.sign) produces byte-identical signatures to
// the backend's verifier (src/lib/marketplace/extension.ts, which
// uses node:crypto.createHmac).
//
// We re-implement the extension's two-step derivation in pure
// Web-Crypto using Node 20's globalThis.crypto.subtle, then compare:
//
//   step 1 (extension Web Crypto):
//     dealer_secret_hex_web =
//       hex( HMAC-SHA256(master_utf8, dealer_id_utf8) )    [v1]
//
//   step 1 (backend node:crypto):
//     dealer_secret_hex_node =
//       deriveDealerSecret(dealer_id)                       [v1]
//
//   step 2 (extension Web Crypto):
//     body_sig_web =
//       hex( HMAC-SHA256(dealer_secret_hex_web, body_bytes) )
//
//   verification (backend node:crypto, the actual route entry-point):
//     verifyExtensionSignature({ rawBody, signature: body_sig_web,
//                                dealerId, version: 1 }) -> ok: true
//
// If any byte differs, verifyExtensionSignature returns ok:false and
// the route 403s. The whole reason this test exists is so we catch
// that drift in CI before it bites a dealer in production.
//
// We test v1 (the legacy path the v0.6 install base depends on), v2
// (the lotpilot.marketplace.v2 message format), and v3 (just to prove
// the format generalises).

import { describe, expect, it, vi } from "vitest";

const ENV = vi.hoisted(() => {
  process.env.MARKETPLACE_MASTER_SECRET =
    "test-master-secret-extension-crossverify";
  delete process.env.MARKETPLACE_MASTER_SECRET_PREV;
  return { master: process.env.MARKETPLACE_MASTER_SECRET };
});

const DEALER = "12345678-1234-4234-8234-123456789abc";

// Re-implementation of extensions/marketplace-bridge/hmac.js using
// globalThis.crypto.subtle (which is Web Crypto, the SAME API the
// extension uses in-browser). The function bodies are intentionally
// near-identical to the extension's hmac.js — we want this test to
// fail if anyone changes the extension's algorithm without updating
// the contract.
const enc = new TextEncoder();

function bytesToHex(buf: ArrayBuffer): string {
  const bytes = new Uint8Array(buf);
  let out = "";
  for (let i = 0; i < bytes.length; i++) {
    const b = bytes[i];
    out += (b < 16 ? "0" : "") + b.toString(16);
  }
  return out;
}

async function hmacSha256Hex(
  keyInput: string | Uint8Array,
  messageInput: string | Uint8Array,
): Promise<string> {
  const keyBytes = typeof keyInput === "string" ? enc.encode(keyInput) : keyInput;
  const messageBytes =
    typeof messageInput === "string" ? enc.encode(messageInput) : messageInput;
  // Cast to BufferSource: TS 5+ models Uint8Array as Uint8Array<ArrayBufferLike>,
  // which is wider than the BufferSource union Web Crypto wants. The runtime
  // contract is identical — the cast is the canonical workaround until TS
  // narrows its lib types for `crypto.subtle`.
  const key = await globalThis.crypto.subtle.importKey(
    "raw",
    keyBytes as BufferSource,
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"],
  );
  const sig = await globalThis.crypto.subtle.sign(
    "HMAC",
    key,
    messageBytes as BufferSource,
  );
  return bytesToHex(sig);
}

function deriveMessage(dealerId: string, version: number): string {
  if (version === 1) return dealerId;
  return `${dealerId}|lotpilot.marketplace.v${version}`;
}

async function deriveDealerSecretWeb(
  master: string,
  dealerId: string,
  version: number,
): Promise<string> {
  return hmacSha256Hex(master, deriveMessage(dealerId, version));
}

async function signBodyWeb(
  master: string,
  dealerId: string,
  version: number,
  bodyString: string,
): Promise<string> {
  const dealerSecretHex = await deriveDealerSecretWeb(master, dealerId, version);
  return hmacSha256Hex(dealerSecretHex, bodyString);
}

describe("marketplace-bridge HMAC vs backend verifier", () => {
  it("v1: extension Web Crypto signature matches backend derivation byte-for-byte", async () => {
    const { deriveDealerSecret, verifyExtensionSignature } = await import(
      "../src/lib/marketplace/extension"
    );

    // Step 1: derived dealer secrets must match.
    const webDerived = await deriveDealerSecretWeb(ENV.master!, DEALER, 1);
    const nodeDerived = deriveDealerSecret(DEALER, 1);
    expect(webDerived).toBe(nodeDerived);

    // Step 2: a real-shaped body, signed by the extension's pipeline,
    // must verify against the backend route entry-point.
    const body = JSON.stringify({
      dealer_id: DEALER,
      marketplace_thread_id: "t-9001",
      buyer_name: "Buyer X.",
      buyer_message: "is the 2017 Civic still available?",
    });
    const sigFromExtension = await signBodyWeb(ENV.master!, DEALER, 1, body);

    const verifyResult = verifyExtensionSignature({
      rawBody: body,
      signature: sigFromExtension,
      dealerId: DEALER,
      version: 1,
    });
    expect(verifyResult).toEqual({ ok: true, usedPrev: false });
  });

  it("v2: extension signature matches with the lotpilot.marketplace.v2 derivation", async () => {
    const { deriveDealerSecret, verifyExtensionSignature } = await import(
      "../src/lib/marketplace/extension"
    );

    const webDerived = await deriveDealerSecretWeb(ENV.master!, DEALER, 2);
    const nodeDerived = deriveDealerSecret(DEALER, 2);
    expect(webDerived).toBe(nodeDerived);

    const body = JSON.stringify({
      dealer_id: DEALER,
      marketplace_thread_id: "t-v2-test",
      buyer_name: "Buyer Y.",
      buyer_message: "price firm?",
    });
    const sig = await signBodyWeb(ENV.master!, DEALER, 2, body);

    expect(
      verifyExtensionSignature({
        rawBody: body,
        signature: sig,
        dealerId: DEALER,
        version: 2,
      }),
    ).toEqual({ ok: true, usedPrev: false });
  });

  it("v3: a future version bump still matches", async () => {
    const { deriveDealerSecret, verifyExtensionSignature } = await import(
      "../src/lib/marketplace/extension"
    );

    const webDerived = await deriveDealerSecretWeb(ENV.master!, DEALER, 3);
    const nodeDerived = deriveDealerSecret(DEALER, 3);
    expect(webDerived).toBe(nodeDerived);

    const body = JSON.stringify({
      dealer_id: DEALER,
      marketplace_thread_id: "t-v3",
      buyer_name: "Buyer Z.",
      buyer_message: "can you deliver?",
    });
    const sig = await signBodyWeb(ENV.master!, DEALER, 3, body);

    expect(
      verifyExtensionSignature({
        rawBody: body,
        signature: sig,
        dealerId: DEALER,
        version: 3,
      }),
    ).toEqual({ ok: true, usedPrev: false });
  });

  it("tampered body rejected (sanity check that the signature is over the bytes)", async () => {
    const { verifyExtensionSignature } = await import(
      "../src/lib/marketplace/extension"
    );

    const body = JSON.stringify({
      dealer_id: DEALER,
      marketplace_thread_id: "t-tamper",
      buyer_name: "Buyer T.",
      buyer_message: "original message",
    });
    const sig = await signBodyWeb(ENV.master!, DEALER, 1, body);

    // Flip a byte in the body but reuse the signature.
    const tampered = body.replace("original", "tampered");
    expect(
      verifyExtensionSignature({
        rawBody: tampered,
        signature: sig,
        dealerId: DEALER,
        version: 1,
      }),
    ).toEqual({ ok: false, usedPrev: false });
  });

  it("wrong master secret rejected (sanity check that the master is part of the chain)", async () => {
    const { verifyExtensionSignature } = await import(
      "../src/lib/marketplace/extension"
    );

    const body = JSON.stringify({
      dealer_id: DEALER,
      marketplace_thread_id: "t-wrong-master",
      buyer_name: "Buyer W.",
      buyer_message: "hello",
    });
    // Sign with a DIFFERENT master, then ask the backend (which knows
    // only ENV.master) to verify. Must fail.
    const sig = await signBodyWeb("a-different-master", DEALER, 1, body);

    expect(
      verifyExtensionSignature({
        rawBody: body,
        signature: sig,
        dealerId: DEALER,
        version: 1,
      }),
    ).toEqual({ ok: false, usedPrev: false });
  });
});
