# LotPilot Marketplace Bridge — Architecture (v0.1)

One-pager for the Manifest V3 Chrome extension that watches a dealer's
own Facebook Marketplace inbox and forwards inbound buyer messages to
`/api/marketplace/inbound`.

Audience: the next engineer touching this code, and the dealer support
person who debugs broken selectors when Meta ships an A/B variant.

---

## 1. Why an extension (not API, not email)

Documented in `src/lib/marketplace/extension.ts` lines 1-39. Short
version: Meta's API is TOS-locked, email is too lossy. The dealer is
operating their OWN account, scoped to their OWN inbox — that is
TOS-safe behaviour. We do not auto-reply, we do not scrape contacts, we
do not modify the page.

## 2. Wire contract (matches backend exactly)

POST `${BACKEND_URL}/api/marketplace/inbound`

Headers:

| Header                                | Value                                                |
| ------------------------------------- | ---------------------------------------------------- |
| `content-type`                        | `application/json`                                   |
| `x-lotpilot-dealer-id`                | dealer UUID (the secret is keyed on this)            |
| `x-lotpilot-extension-signature`      | hex HMAC-SHA256 of the raw body, keyed by the derived dealer secret |
| `x-lotpilot-secret-version`           | `1` for v0.6 install base (default); bump on rotation |

Body:

```json
{
  "dealer_id": "uuid",
  "marketplace_thread_id": "stable-thread-id",
  "buyer_name": "First L.",
  "buyer_message": "is the 2017 Civic still available?",
  "listing_id": "optional"
}
```

The backend rejects with 403 if header `dealer_id` != body `dealer_id`
(`route.ts` line 192). We always set both from the same source.

Per-dealer secret derivation (v1, the legacy formula the v0.6 install
base depends on):

```
dealer_secret_hex = HMAC-SHA256(master_secret, dealer_id_utf8) -> hex
```

HMAC is then computed over the EXACT bytes of the JSON body string we
send. We do NOT re-`JSON.stringify` between sign + send — there is one
canonical body string and we hand it to both `crypto.subtle.sign` and
`fetch`.

NB: the task brief mentioned `${dealer_id}|lotpilot.marketplace.v1` —
that is the v2+ formula. v1 is `dealer_id` alone. See
`extension.ts:76-83`. We default to v1 so a fresh install works against
today's backend.

## 3. DOM hook strategy (the fragile bit)

Facebook obfuscates class names every deploy and ships per-locale and
per-A/B-bucket variants. We use STRUCTURAL + ARIA + role-based hooks
that have been stable across multiple FB rewrites because they are
driven by accessibility requirements, not styling.

Hooks, in order of preference (content.js falls through):

1. **Conversation container**: `div[role="main"]` that contains a
   descendant `div[aria-label*="Messages" i]` OR `aria-label*="Chat" i`.
   Marketplace inbox is rendered inside a Messenger-shaped pane and this
   pair has been stable since the Messenger rewrite. Documented at
   content.js `SELECTORS.conversationRoot`.

2. **Message rows**: `div[role="row"]` is the per-message wrapper FB
   uses inside the virtualised message list. Each row has either an
   `aria-label` (screen-reader-visible) or contains an inner
   `[dir="auto"]` text node — we grab whichever exists.

3. **Direction (inbound vs outbound)**: outbound messages are rendered
   right-aligned and FB tags them with `data-scope="messages_table"` +
   a positional flag we can read from the row's flex direction. The
   stable signal: outbound rows place the avatar AFTER the bubble,
   inbound rows place the avatar BEFORE. We detect by checking whether
   the row's first child is the avatar wrapper (`[role="img"]` with
   `aria-label` matching the OTHER user) — if yes, inbound; if no,
   outbound. Fallback: check `style.justifyContent`. Last-resort
   fallback: read `aria-label` on the row itself, which FB sets to
   include "sent by {name}" — if name === self, outbound; else inbound.

4. **Self identity**: scraped once on script load from the top-bar
   profile link (`a[role="link"][href="/me/"]` or
   `[aria-label*="Your profile" i]`). Cached in `chrome.storage.local`
   under `selfName` so we can compare against row author names without
   re-querying. Dealers update this manually in popup if FB changes the
   shape.

5. **Thread id**: read from the URL —
   `/messages/t/<numericThreadId>/` or
   `/marketplace/inbox/<encodedThreadId>/`. We URI-encode and slice to
   200 chars to fit the backend's `marketplace_thread_id` cap
   (`extension.ts:209`).

6. **Buyer name**: the conversation header h1 — `header h1`, OR
   `[role="heading"][aria-level="1"]` if h1 isn't present. Trimmed,
   capped at 200 chars to match backend validation.

The CONFIG object at the top of `content.js` exposes every selector so
a dealer can swap one string when a variant lands — no rebuild, just
edit + reload.

## 4. Data flow

```
+----------------------+  MutationObserver
| FB conversation root |─────────────────────────┐
+----------------------+                          │
                                                  ▼
                                    +-----------------------------+
                                    | content.js: detect inbound  |
                                    | row, extract text + thread  |
                                    | id + buyer name + ts        |
                                    +-----------------------------+
                                                  │ dedupe (chrome.storage.local)
                                                  ▼
                                    +-----------------------------+
                                    | hmac.js: Web Crypto sign    |
                                    | body bytes → hex            |
                                    +-----------------------------+
                                                  │ chrome.runtime.sendMessage
                                                  ▼
                                    +-----------------------------+
                                    | background.js: retry queue  |
                                    | (exponential backoff)       |
                                    +-----------------------------+
                                                  │ fetch()
                                                  ▼
                                +-------------------------------------+
                                | POST /api/marketplace/inbound       |
                                |  verifyExtensionSignature → ok      |
                                |  runChatTurn → AI draft             |
                                +-------------------------------------+
                                                  │
                                                  ▼
                                    +-----------------------------+
                                    | background.js: update badge |
                                    | + log ring buffer           |
                                    +-----------------------------+
```

Why background.js owns the queue: content scripts die on navigation.
The MV3 service worker survives across SPA route changes (Marketplace
is a SPA inside facebook.com) and survives short tab closes. We
persist pending posts in `chrome.storage.local` so a service worker
unload + reload still drains the queue.

## 5. Retry strategy

- On `fetch` failure (network) or 5xx: exponential backoff
  `min(2^n * 1s, 60s)` for up to 6 attempts.
- On 403 / 401: STOP retrying; surface "auth error — check popup
  config" in the log ring + badge `offline`. Re-trying a bad HMAC just
  fills the dealer's rate-limit bucket.
- On 200 with `kind: "rate_limited"`: delay by `retry_after_sec` and
  retry once. The backend explicitly returns 200 here (not 429) so
  extensions don't loop on it — see `route.ts:206-218`.
- Queue is capped at 200 entries. Overflow drops the OLDEST entries
  and logs "queue overflow".

## 6. Dedupe key

`sha256(thread_id + "|" + first 100 chars of buyer_message + "|" +
floor(timestamp / 60_000))` — minute-bucketed so DOM re-renders of the
same message within the virtual scroller don't refire, but a buyer
sending the same text again 5 minutes later DOES (legitimate re-ping).

Stored in `chrome.storage.local.dedup` as a ring of the last 500 keys.

## 7. Badge states

- `synced` (green): last POST in the last 5 min returned 2xx.
- `offline` (red): last 3 POSTs failed OR no config.
- `idle` (grey): no posts in the last 30 min but config present.
- `unconfigured` (yellow `!`): popup never saved a backend URL.

Updated by `background.js` on each POST result.

## 8. Known limitations

- **No Chrome Web Store distribution**. Dealers side-load via
  `chrome://extensions` → "Load unpacked". Onboarding doc must walk
  through that flow; popup health-check button is the smoke test.
- **No mobile Chrome**. MV3 extensions don't run on mobile Chrome,
  full stop. Dealer must use desktop Chrome (or Edge) with FB open.
  The marketing copy "we install the extension on your phone" is
  wrong; the install is desktop-only. Flag for marketing.
- **Single dealer per browser profile**. Multi-dealer staff would need
  separate Chrome profiles. Acceptable for v0.1.
- **Selectors WILL break**. The CONFIG block in `content.js` is the
  knob to twist. README documents how to debug with DevTools.
- **No auto-reply**. By design — TCPA + Meta TOS. The dealer sees the
  AI draft in their dashboard inbox and pastes manually.
- **No outbound scraping**. We never read messages the dealer sent —
  filtered out by the direction-detection logic. This protects against
  accidentally training on the dealer's own writing style or sending
  outbound text upstream where it could be misclassified as inbound.
