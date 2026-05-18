# LotPilot Marketplace Bridge

Chrome extension that forwards inbound Facebook Marketplace buyer
messages from your own Facebook account to your LotPilot dashboard.

**What it does:** when a buyer messages you on Marketplace, the
extension sees the new message in your inbox, HMAC-signs the contents,
and POSTs it to your LotPilot backend so the AI can draft a reply that
appears in your LotPilot dashboard.

**What it does NOT do:**

- It does not auto-reply on your behalf.
- It does not modify or hide anything on Facebook's pages.
- It does not read messages you sent (only inbound buyer messages).
- It does not touch any other Facebook surface (no News Feed, no
  contacts, no friend list).

## Install (side-load, ~2 minutes)

The extension is not on the Chrome Web Store. You "side-load" it. This
is the same flow used by every internal company tool.

1. Open Chrome (or Edge — same flow).
2. Visit `chrome://extensions`.
3. Toggle **Developer mode** ON (top right).
4. Click **Load unpacked**.
5. Select this folder (`extensions/marketplace-bridge`).
6. The LotPilot icon appears in the extension toolbar. Pin it.
7. Click the icon. The popup opens.
8. Fill in:
   - **Backend URL**: e.g. `https://app.lotpilot.com`
   - **Dealer UUID**: from your LotPilot welcome email
   - **Master Secret**: from your LotPilot welcome email
   - **Secret Version**: leave as `1` unless support tells you otherwise
9. Click **Save**. Then click **Run health check**.

A successful health check shows a green "OK (ok, status 200)" or
"OK (dealer-not-found, status 404)" — both mean the signature is valid.

If you see "signature-rejected" (403), the master secret is wrong.

## Mobile / tablet?

This extension is **desktop Chrome only**. Mobile Chrome does not run
extensions. If you usually run Marketplace on your phone, keep
Facebook open in a Chrome tab on your laptop while you're at the lot
— the extension just needs the tab to exist somewhere.

## Daily usage

Open `facebook.com/marketplace/inbox` in any Chrome tab. The extension
runs automatically when you're on that page. The icon badge tells you
the current state:

| Badge | Meaning |
| ----- | ------- |
| (green) **ok** | Last post in the last 5 minutes succeeded. |
| (red) **off** | Last 3 posts failed. Check the popup logs. |
| (yellow) **!** | The popup isn't fully configured. |
| (blank) | Idle. No recent activity. |

Click the icon to open the popup. Recent Activity shows the last ~50
log lines so you can see what's been sent.

## When it stops working

Facebook routinely renames CSS classes and ships A/B variants of the
Marketplace inbox. When that happens the extension may stop detecting
new messages. **This is expected, not a bug** — just a sign we need to
update one selector. Three things to try in order:

### 1. Re-load the extension

`chrome://extensions` → find LotPilot → click the circular **reload**
icon. Then refresh your Facebook tab.

### 2. Open the popup logs

If new messages aren't appearing in the activity feed, the extension
isn't detecting them — meaning the DOM selectors are out of date.

### 3. Patch one selector

Open `content.js` in this folder. The very top has a `CONFIG` block:

```js
const CONFIG = {
  conversationRoot: [ 'div[role="main"]', ... ],
  messageList:      [ 'div[role="grid"]', ... ],
  messageRow:       [ 'div[role="row"]', ... ],
  conversationHeader: [ 'header h1', ... ],
  selfProfileLink:  [ 'a[role="link"][aria-label*="Your profile" i]', ... ],
};
```

Each key has a primary selector and 1–2 fallbacks. To debug a single
broken hook:

1. Open Facebook Marketplace inbox in a tab.
2. Open DevTools (`F12` or right-click → Inspect).
3. In the Console tab, paste:
   ```js
   document.querySelectorAll('div[role="row"]').length
   ```
   That should equal the number of messages visible. If it's 0, the
   row selector needs updating. Right-click the message bubble →
   Inspect → look at the parent element for stable attributes (look
   for `role`, `aria-label`, `data-testid` — NOT class names, which
   change every release).
4. Edit `content.js`, add your new selector to the FRONT of the array,
   save, and reload the extension.
5. Send yourself a test message from another account.

Email `support@lotpilot.com` with the broken selector and the new one
that works — we'll roll it into the next extension release for every
dealer.

## What gets sent

For each inbound buyer message, the extension sends:

```http
POST /api/marketplace/inbound HTTP/1.1
content-type: application/json
x-lotpilot-dealer-id: <your UUID>
x-lotpilot-extension-signature: <hex HMAC-SHA256 of body>
x-lotpilot-secret-version: 1

{
  "dealer_id": "<your UUID>",
  "marketplace_thread_id": "<FB thread id>",
  "buyer_name": "<buyer display name>",
  "buyer_message": "<buyer message text>"
}
```

The signature is `HMAC-SHA256(derivedSecret, body)` where the derived
secret is `HMAC-SHA256(masterSecret, dealerId)` in hex. The master
secret never leaves your browser — only the signature does.

## Privacy

- The extension reads ONLY pages under `facebook.com/marketplace/*`
  and `facebook.com/messages/*` (see `manifest.json` → `host_permissions`).
- Outbound messages are skipped — direction detection runs before any
  network call.
- No third-party services are contacted. Only your LotPilot backend.
- All config (URL, dealer UUID, master secret) is stored in
  `chrome.storage.local`, which is scoped to your browser profile.

## Files in this folder

| File              | Purpose |
| ----------------- | ------- |
| `manifest.json`   | Extension manifest (MV3). |
| `content.js`      | Watches Facebook DOM, extracts inbound messages. |
| `background.js`   | Service worker. Signs, POSTs, retries, manages the badge. |
| `hmac.js`         | Shared HMAC helper. |
| `popup.html/css/js` | Configuration UI. |
| `ARCHITECTURE.md` | Design + DOM-hook reasoning. |
| `CHANGELOG.md`    | Per-version notes. |

## Versioning

Track changes in `CHANGELOG.md`. Bump `manifest.json:version` when
shipping a new build. Dealers reload the extension to pick up changes.
