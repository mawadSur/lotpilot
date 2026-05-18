// LotPilot Marketplace Bridge — HMAC helpers.
//
// This file is shared between the content script and the popup. It is
// loaded as a plain script (no modules) so it must self-register on a
// global namespace. Manifest V3 service workers ARE module-capable
// (manifest.json sets "type": "module") but content_scripts cannot
// import modules — that's why we use the IIFE-on-globalThis pattern.
//
// The single source of truth for the wire format is the backend file
// src/lib/marketplace/extension.ts. Read that BEFORE changing anything
// here. Specifically:
//
//   - v1 derivation (legacy, default for v0.6+ installs):
//        secret_hex = HMAC-SHA256(master_utf8, dealer_id_utf8) -> hex
//     The HMAC KEY is the master bytes; the MESSAGE is the dealer_id
//     bytes. The output is hex (64 chars). The hex string is then used
//     as the KEY for the body HMAC. The body HMAC output is also hex.
//
//   - v2+ derivation:
//        secret_hex = HMAC-SHA256(master, `${dealer_id}|lotpilot.marketplace.v${N}`) -> hex
//
// Web Crypto's HMAC-SHA256 expects key + message as ArrayBuffer/Uint8Array.
// crypto.subtle.importKey + crypto.subtle.sign give us the same bytes
// Node's createHmac produces — that equivalence is verified by
// tests/marketplace-extension-hmac.test.ts, which cross-checks our
// Web-Crypto-style derivation against node:crypto, which is what the
// server uses.

(function bootstrapHmac(globalScope) {
  const UUID_RE =
    /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

  const enc = new TextEncoder();

  function bytesToHex(buf) {
    const bytes = new Uint8Array(buf);
    let out = "";
    for (let i = 0; i < bytes.length; i++) {
      const b = bytes[i];
      out += (b < 16 ? "0" : "") + b.toString(16);
    }
    return out;
  }

  async function importHmacKey(keyBytes) {
    return crypto.subtle.importKey(
      "raw",
      keyBytes,
      { name: "HMAC", hash: "SHA-256" },
      false,
      ["sign"],
    );
  }

  // Compute HMAC-SHA256(key, message) -> hex string.
  // Accepts strings (utf-8 encoded) or Uint8Arrays for both args.
  async function hmacSha256Hex(keyInput, messageInput) {
    const keyBytes =
      typeof keyInput === "string" ? enc.encode(keyInput) : keyInput;
    const messageBytes =
      typeof messageInput === "string" ? enc.encode(messageInput) : messageInput;
    const key = await importHmacKey(keyBytes);
    const sig = await crypto.subtle.sign("HMAC", key, messageBytes);
    return bytesToHex(sig);
  }

  // Build the v1/v2+ message that gets HMAC'd to produce the per-dealer
  // secret. KEEP THIS FUNCTION ALIGNED WITH extension.ts deriveBytes().
  function deriveMessage(dealerId, version) {
    if (version === 1) return dealerId;
    return `${dealerId}|lotpilot.marketplace.v${version}`;
  }

  // Derive the per-dealer secret HEX string. The result is the KEY used
  // to sign the request body (the key is the hex string itself, utf-8
  // encoded — that's what the Node side does via createHmac("sha256", secret)
  // where `secret` is the hex string).
  async function deriveDealerSecret(masterSecret, dealerId, version = 1) {
    if (typeof masterSecret !== "string" || masterSecret.length === 0) {
      throw new Error("deriveDealerSecret: masterSecret required");
    }
    if (!UUID_RE.test(dealerId)) {
      throw new Error("deriveDealerSecret: dealerId must be a UUID");
    }
    if (!Number.isInteger(version) || version < 1) {
      throw new Error("deriveDealerSecret: version must be integer >= 1");
    }
    return hmacSha256Hex(masterSecret, deriveMessage(dealerId, version));
  }

  // Compute the body signature header value (hex string of 64 chars)
  // for the EXACT body bytes passed in. The caller MUST send the same
  // bodyString to fetch — re-stringifying after signing would re-order
  // keys on some engines and break verification.
  async function signBody(masterSecret, dealerId, version, bodyString) {
    const dealerSecretHex = await deriveDealerSecret(
      masterSecret,
      dealerId,
      version,
    );
    return hmacSha256Hex(dealerSecretHex, bodyString);
  }

  const api = {
    bytesToHex,
    hmacSha256Hex,
    deriveDealerSecret,
    signBody,
    UUID_RE,
  };

  // Expose on globalThis under a stable name. Content scripts run in
  // an isolated world so we don't pollute the page's globals.
  globalScope.LotPilotHmac = api;
  // Also expose for ES module callers (background.js imports this same
  // file via static import in tests; the module shim is below). In
  // service-worker module context, `globalThis` IS the module scope,
  // so attaching here is enough.
})(typeof self !== "undefined" ? self : globalThis);

// For Node test consumers — exported via CommonJS-style shim guarded
// by typeof. Browsers ignore this branch.
if (typeof module !== "undefined" && module.exports) {
  module.exports = (typeof self !== "undefined" ? self : globalThis).LotPilotHmac;
}
