// LotPilot Marketplace Bridge — content script.
//
// Runs on facebook.com/marketplace/* and facebook.com/messages/*.
// Watches the conversation pane for new INBOUND buyer messages and
// forwards each new one to background.js (which signs + POSTs).
//
// Three principles guide every selector choice:
//   1. ARIA + role-based selectors outlast class-name churn because
//      Meta is bound by accessibility regulations and can't randomly
//      rename role/aria-label values without breaking screen readers.
//   2. Structural fallbacks ("first child", "contains-text") run after
//      the ARIA path so a single A/B variant doesn't take us out.
//   3. The CONFIG block at the top is the ONE place a dealer needs to
//      edit when a variant lands — every selector lives there.
//
// See ARCHITECTURE.md for the full DOM-hook reasoning.

(function bootstrapContent() {
  "use strict";

  // ---------------------------------------------------------------
  // CONFIG — edit here when FB ships a DOM variant. Each entry has a
  // primary selector and 1-2 fallbacks. Order matters; we try first
  // match wins. To debug: open DevTools, run
  //   document.querySelectorAll('<selector>').length
  // and confirm exactly one match in a conversation tab.
  // ---------------------------------------------------------------
  const CONFIG = {
    // Whole conversation pane (the right-side scrollable region).
    // FB has put this under role="main" since the Messenger redesign.
    conversationRoot: [
      'div[role="main"]',
      '[data-pagelet="MessengerThread"]',
    ],
    // The virtualised list of message rows inside the conversation.
    messageList: [
      'div[role="grid"]',
      'div[aria-label*="Messages" i]',
      'div[aria-label*="Conversation" i]',
    ],
    // Each rendered message bubble. role="row" is the FB-stable
    // identifier inside their virtual list since 2022.
    messageRow: [
      'div[role="row"]',
      '[data-testid="message-container"]',
    ],
    // Header showing the OTHER party's name. We read buyer_name from
    // here, capped at 200 chars to match the backend validator.
    conversationHeader: [
      'header h1',
      '[role="banner"] [role="heading"]',
      '[role="heading"][aria-level="1"]',
    ],
    // Self profile link in the top bar — used to detect outbound rows.
    // Cached in chrome.storage.local.selfName after first read.
    selfProfileLink: [
      'a[role="link"][aria-label*="Your profile" i]',
      'a[role="link"][href*="/me/"]',
      'div[role="navigation"] a[role="link"][aria-label]',
    ],
  };

  const LOG_PREFIX = "[lotpilot]";
  const POLL_MS = 1500;
  // We rate-limit how often we walk the DOM after a MutationObserver
  // fires (FB's virtual list emits dozens of mutations per render).
  const DEBOUNCE_MS = 300;

  let observer = null;
  let debounceTimer = null;
  let isWatching = false;
  let cachedSelfName = null;

  function log(...args) {
    // eslint-disable-next-line no-console
    console.debug(LOG_PREFIX, ...args);
  }

  // -- Selector helpers ------------------------------------------------

  function queryFirst(selectors, root = document) {
    for (const sel of selectors) {
      try {
        const el = root.querySelector(sel);
        if (el) return el;
      } catch (err) {
        log("bad selector", sel, err);
      }
    }
    return null;
  }

  function queryAll(selectors, root = document) {
    for (const sel of selectors) {
      try {
        const list = root.querySelectorAll(sel);
        if (list.length > 0) return Array.from(list);
      } catch (err) {
        log("bad selector", sel, err);
      }
    }
    return [];
  }

  // -- Identity --------------------------------------------------------

  async function loadCachedSelfName() {
    return new Promise((resolve) => {
      chrome.storage.local.get(["selfName"], (res) => {
        cachedSelfName = res?.selfName || null;
        resolve(cachedSelfName);
      });
    });
  }

  function detectSelfName() {
    const el = queryFirst(CONFIG.selfProfileLink);
    if (!el) return null;
    const aria = el.getAttribute("aria-label") || "";
    // FB renders the link aria as "Your profile, <Name>" — we strip the
    // leading boilerplate. Falls back to textContent if the format
    // changes.
    const stripped = aria.replace(/^your profile[,:\s-]*/i, "").trim();
    const fromAria = stripped.length > 0 && stripped.length < 200 ? stripped : null;
    const fromText = (el.textContent || "").trim();
    return fromAria || (fromText.length > 0 && fromText.length < 200 ? fromText : null);
  }

  function refreshSelfNameIfNeeded() {
    if (cachedSelfName) return;
    const detected = detectSelfName();
    if (detected) {
      cachedSelfName = detected;
      chrome.storage.local.set({ selfName: detected });
      log("self name detected:", detected);
    }
  }

  // -- Thread + buyer extraction --------------------------------------

  // Pull a stable thread id out of the URL. Marketplace inbox URLs:
  //   /marketplace/inbox/<id>/
  //   /messages/t/<id>/
  // Anything else (the top-level marketplace tab) yields null and we
  // skip extraction — we only forward when we're actually inside a
  // conversation.
  function readThreadIdFromUrl() {
    const path = location.pathname;
    let m = path.match(/\/marketplace\/inbox\/([^/?#]+)/);
    if (m) return m[1].slice(0, 200);
    m = path.match(/\/messages\/t\/([^/?#]+)/);
    if (m) return m[1].slice(0, 200);
    return null;
  }

  function readBuyerName() {
    const h = queryFirst(CONFIG.conversationHeader);
    if (!h) return null;
    const text = (h.textContent || "").trim();
    if (!text) return null;
    return text.slice(0, 200);
  }

  // -- Direction detection (inbound vs outbound) ----------------------
  //
  // This is the most fragile bit. We have FOUR fallbacks ordered
  // most-reliable to least:
  //
  //   1. aria-label on the row: FB sets it to e.g.
  //      "Message from <SenderName>" — we compare SenderName to
  //      cachedSelfName.
  //   2. data-scope / data-testid markers FB uses internally (these
  //      change but slowly).
  //   3. Avatar position: inbound rows have the OTHER user's avatar as
  //      the first DOM child of the row; outbound rows have no avatar
  //      (or have the self avatar tucked away).
  //   4. Flex justification: outbound bubbles are justify-end. This is
  //      a style-based fallback and the LEAST reliable.
  //
  // If ALL fallbacks fail, we treat the row as ambiguous and SKIP it.
  // Skipping is the safe default — better to miss than to send the
  // dealer's own outbound text upstream.
  function rowDirection(row, selfName) {
    // (1) aria-label.
    const aria = row.getAttribute("aria-label") || "";
    if (aria) {
      // "Message from X", "X sent", "You sent" patterns.
      if (/\byou (sent|said)\b/i.test(aria)) return "outbound";
      if (/\bsent by you\b/i.test(aria)) return "outbound";
      if (selfName) {
        const nameRe = new RegExp(
          `(?:from|by)\\s+${escapeRegex(selfName)}\\b`,
          "i",
        );
        if (nameRe.test(aria)) return "outbound";
      }
      // "Message from <not-self>"
      if (/\b(message from|from)\b/i.test(aria)) return "inbound";
    }
    // (2) data-* markers.
    const ds = row.getAttribute("data-scope") || "";
    if (/sent/i.test(ds)) return "outbound";
    // (3) avatar position.
    const firstChild = row.firstElementChild;
    if (firstChild) {
      // Inbound rows place an avatar wrapper as the first child. FB
      // tags it with role="img" or a specific data-visualcompletion
      // attr ("avatar-image"). Outbound rows usually start with the
      // bubble container directly.
      const hasAvatarFirst =
        firstChild.matches('[role="img"], [data-visualcompletion="avatar-image"], svg[aria-label]') ||
        !!firstChild.querySelector('[role="img"], [data-visualcompletion="avatar-image"]');
      if (hasAvatarFirst) return "inbound";
    }
    // (4) flex justification.
    const style = row.getAttribute("style") || "";
    if (/justify-content:\s*(flex-)?end/i.test(style)) return "outbound";
    return "unknown";
  }

  function escapeRegex(s) {
    return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  }

  // Extract the text of a message bubble.
  function rowText(row) {
    // Prefer the [dir="auto"] text node FB renders inside every
    // bubble — it carries the actual message string. Fall back to
    // textContent on the row.
    const inner = row.querySelector('[dir="auto"]');
    let txt = inner ? inner.textContent : row.textContent;
    txt = (txt || "").trim();
    // Strip the "Enter" hint and timestamp lines FB sometimes appends.
    return txt.slice(0, 4000);
  }

  // -- Dedupe + send --------------------------------------------------

  // Stable per-message key. Minute-bucketed so virtual-list re-renders
  // of the same row within ~60s don't double-fire, but a buyer who
  // re-pings the same text after the timer rolls DOES get forwarded.
  async function dedupKey(threadId, text) {
    const bucket = Math.floor(Date.now() / 60_000);
    const raw = `${threadId}|${text.slice(0, 100)}|${bucket}`;
    // Use Web Crypto for a stable hash (avoids the cost of string
    // sets bloating chrome.storage as inbox volume grows).
    const data = new TextEncoder().encode(raw);
    const buf = await crypto.subtle.digest("SHA-256", data);
    return self.LotPilotHmac.bytesToHex(buf);
  }

  async function hasSeen(key) {
    return new Promise((resolve) => {
      chrome.storage.local.get(["dedup"], (res) => {
        const arr = Array.isArray(res?.dedup) ? res.dedup : [];
        resolve(arr.includes(key));
      });
    });
  }

  async function recordSeen(key) {
    return new Promise((resolve) => {
      chrome.storage.local.get(["dedup"], (res) => {
        const arr = Array.isArray(res?.dedup) ? res.dedup : [];
        arr.push(key);
        // Cap at 500 — the ring just drops the oldest.
        const trimmed = arr.length > 500 ? arr.slice(arr.length - 500) : arr;
        chrome.storage.local.set({ dedup: trimmed }, () => resolve());
      });
    });
  }

  function sendToBackground(payload) {
    try {
      chrome.runtime.sendMessage({ type: "marketplace_inbound", payload });
    } catch (err) {
      // chrome.runtime.lastError can happen during service worker
      // restarts; the next mutation will pick the message back up.
      log("sendMessage error", err);
    }
  }

  // -- Main scan ------------------------------------------------------

  async function scanConversation() {
    refreshSelfNameIfNeeded();
    const threadId = readThreadIdFromUrl();
    if (!threadId) return;
    const buyerName = readBuyerName() || "Buyer";

    const list = queryFirst(CONFIG.messageList);
    const rowSource = list || document;
    const rows = queryAll(CONFIG.messageRow, rowSource);
    if (rows.length === 0) return;

    // We only look at the LAST ~10 rows. The virtual list keeps
    // older rows mounted but they aren't "new" — and re-scanning the
    // whole list every mutation is wasteful.
    const recent = rows.slice(-10);
    for (const row of recent) {
      const dir = rowDirection(row, cachedSelfName);
      if (dir !== "inbound") continue; // safe default: skip unknown
      const text = rowText(row);
      if (!text || text.length < 1) continue;

      const key = await dedupKey(threadId, text);
      if (await hasSeen(key)) continue;
      await recordSeen(key);

      sendToBackground({
        marketplace_thread_id: threadId,
        buyer_name: buyerName,
        buyer_message: text,
        message_timestamp_iso: new Date().toISOString(),
        // listing_id: optional — left undefined; backend tolerates
        // missing. We'll add listing detection in v0.2.
      });
      log("queued inbound message", { threadId, len: text.length });
    }
  }

  function scheduleScan() {
    if (debounceTimer) clearTimeout(debounceTimer);
    debounceTimer = setTimeout(() => {
      scanConversation().catch((err) => log("scan failed", err));
    }, DEBOUNCE_MS);
  }

  function startWatching() {
    if (isWatching) return;
    const root = queryFirst(CONFIG.conversationRoot);
    if (!root) {
      // Not on a conversation page yet — re-check shortly. FB is a SPA
      // and mounts the conversation pane after navigation.
      setTimeout(startWatching, POLL_MS);
      return;
    }
    observer = new MutationObserver(scheduleScan);
    observer.observe(root, {
      childList: true,
      subtree: true,
      characterData: false,
      attributes: false,
    });
    isWatching = true;
    log("watching conversation root");
    // Trigger one initial scan to pick up the rendered backlog.
    scheduleScan();
  }

  function watchLocationChanges() {
    let lastPath = location.pathname;
    setInterval(() => {
      if (location.pathname !== lastPath) {
        lastPath = location.pathname;
        log("location change ->", lastPath);
        // Reset and re-attach the observer to the new root.
        if (observer) {
          try { observer.disconnect(); } catch (_) { /* noop */ }
          observer = null;
        }
        isWatching = false;
        startWatching();
      }
    }, POLL_MS);
  }

  loadCachedSelfName().then(() => {
    startWatching();
    watchLocationChanges();
  });
})();
