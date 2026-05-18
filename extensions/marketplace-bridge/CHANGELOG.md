# Changelog

All notable changes to the LotPilot Marketplace Bridge extension.

## v0.1.0 — 2026-05-18

Initial side-load release. Pairs with backend
`POST /api/marketplace/inbound` (v0.7 contract).

### Added
- Manifest V3 manifest with minimal permissions (`storage` only).
  Host permissions scoped to `https://www.facebook.com/*`.
- Content script (`content.js`) running on
  `facebook.com/marketplace/*` and `facebook.com/messages/*`. Uses
  ARIA + role-based selectors with documented fallbacks. CONFIG block
  at the top of the file is the single place to patch selectors when
  Facebook ships an A/B variant.
- Direction detection (inbound vs outbound) with four ordered
  fallbacks. Ambiguous rows are skipped on purpose — better to miss a
  message than to forward outbound text as inbound.
- Service-worker background script (`background.js`) with persistent
  retry queue, exponential backoff (1s → 60s, max 6 attempts), badge
  state machine (ok / off / idle / unconfigured), and in-memory log
  ring buffer.
- HMAC helper (`hmac.js`) using Web Crypto's `crypto.subtle`. Matches
  the backend's `deriveDealerSecret` for v1 (legacy) and v2+ payloads.
- Popup UI (`popup.html` + `popup.js` + `popup.css`): backend URL,
  dealer UUID, master secret, secret version, Save button, Run health
  check button, status panel, and last-50-log-lines feed.
- README with side-load instructions, badge legend, DOM-debug
  recipe, and dealer-facing selector-patching steps.
- ARCHITECTURE.md with the DOM-hook strategy, data flow, retry
  strategy, and known limitations.
- Cross-validation test
  (`tests/marketplace-extension-hmac.test.ts`) that re-implements the
  Web-Crypto-style derivation using `node:crypto` and verifies the
  bytes match the backend's `deriveDealerSecret` exactly for v1, v2,
  and v3 cases.

### Notes
- Mobile Chrome is unsupported (no MV3 extension support on Android
  Chrome). Marketing copy referencing "phone install" must be updated.
- Distribution is side-load only (`chrome://extensions` → Load
  unpacked) until a Chrome Web Store listing is approved.
- No icons shipped in this release — Chrome renders the default
  puzzle-piece icon. Replace `icons/icon-{16,32,48,128}.png` in a
  future patch.
