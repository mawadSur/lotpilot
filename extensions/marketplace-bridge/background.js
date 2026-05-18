// LotPilot Marketplace Bridge — MV3 service worker.
//
// Responsibilities:
//   1. Receive `marketplace_inbound` messages from content.js.
//   2. Sign each payload with the dealer-derived HMAC (via hmac.js).
//   3. POST to ${BACKEND_URL}/api/marketplace/inbound.
//   4. Maintain a persistent retry queue across worker unloads.
//   5. Update the toolbar badge to reflect health.
//   6. Append to an in-memory log ring buffer (read by popup).
//
// The MV3 service worker can be evicted at any time. Anything we want
// to survive eviction MUST live in chrome.storage.local. The in-memory
// ring buffer is intentionally NOT persisted — it's just a debugging
// surface that resets when the worker restarts. Persistent diagnostics
// would be a separate feature (file an issue, don't bolt it in here).

import "./hmac.js";

// ---------------------------------------------------------------
// Constants
// ---------------------------------------------------------------
const QUEUE_KEY = "outboundQueue";
const CONFIG_KEYS = [
  "backendUrl",
  "dealerId",
  "masterSecret",
  "secretVersion",
];
const MAX_QUEUE = 200;
const MAX_ATTEMPTS = 6;
const LOG_RING_MAX = 200;
const SIGNATURE_HEADER = "x-lotpilot-extension-signature";
const DEALER_HEADER = "x-lotpilot-dealer-id";
const VERSION_HEADER = "x-lotpilot-secret-version";

// ---------------------------------------------------------------
// In-memory state (lost on worker eviction; ok)
// ---------------------------------------------------------------
const logRing = [];
let draining = false;
let recentResults = []; // last N booleans for badge state

function pushLog(level, message, extra) {
  const entry = {
    ts: new Date().toISOString(),
    level,
    message,
    extra: extra || null,
  };
  logRing.push(entry);
  if (logRing.length > LOG_RING_MAX) {
    logRing.splice(0, logRing.length - LOG_RING_MAX);
  }
  // eslint-disable-next-line no-console
  console[level === "error" ? "error" : "log"]("[lotpilot-bg]", message, extra || "");
}

// ---------------------------------------------------------------
// Config helpers
// ---------------------------------------------------------------
function loadConfig() {
  return new Promise((resolve) => {
    chrome.storage.local.get(CONFIG_KEYS, (res) => {
      resolve({
        backendUrl: res?.backendUrl || "",
        dealerId: res?.dealerId || "",
        masterSecret: res?.masterSecret || "",
        secretVersion: Number.isInteger(res?.secretVersion)
          ? res.secretVersion
          : 1,
      });
    });
  });
}

function isConfigComplete(cfg) {
  return Boolean(
    cfg.backendUrl &&
      cfg.dealerId &&
      cfg.masterSecret &&
      self.LotPilotHmac.UUID_RE.test(cfg.dealerId),
  );
}

// ---------------------------------------------------------------
// Queue persistence
// ---------------------------------------------------------------
function loadQueue() {
  return new Promise((resolve) => {
    chrome.storage.local.get([QUEUE_KEY], (res) => {
      resolve(Array.isArray(res?.[QUEUE_KEY]) ? res[QUEUE_KEY] : []);
    });
  });
}

function saveQueue(q) {
  return new Promise((resolve) => {
    chrome.storage.local.set({ [QUEUE_KEY]: q }, () => resolve());
  });
}

async function enqueue(payload) {
  const q = await loadQueue();
  q.push({
    id: crypto.randomUUID(),
    payload,
    attempts: 0,
    nextAttemptAt: Date.now(),
    enqueuedAt: Date.now(),
  });
  // Overflow: drop oldest.
  if (q.length > MAX_QUEUE) {
    const dropped = q.length - MAX_QUEUE;
    q.splice(0, dropped);
    pushLog("warn", "queue overflow, dropped oldest", { dropped });
  }
  await saveQueue(q);
  pushLog("info", "enqueued", { size: q.length });
}

// ---------------------------------------------------------------
// Badge management
// ---------------------------------------------------------------
async function updateBadge() {
  const cfg = await loadConfig();
  if (!isConfigComplete(cfg)) {
    await chrome.action.setBadgeText({ text: "!" });
    await chrome.action.setBadgeBackgroundColor({ color: "#ddaa00" });
    await chrome.action.setTitle({
      title: "LotPilot — unconfigured. Click to set up.",
    });
    return;
  }
  const lastN = recentResults.slice(-3);
  const lastOk = lastN.length > 0 && lastN[lastN.length - 1] === true;
  const allFailed = lastN.length >= 3 && lastN.every((r) => r === false);
  if (allFailed) {
    await chrome.action.setBadgeText({ text: "off" });
    await chrome.action.setBadgeBackgroundColor({ color: "#cc3333" });
    await chrome.action.setTitle({ title: "LotPilot — offline (last 3 posts failed)" });
  } else if (lastOk) {
    await chrome.action.setBadgeText({ text: "ok" });
    await chrome.action.setBadgeBackgroundColor({ color: "#1a8754" });
    await chrome.action.setTitle({ title: "LotPilot — synced" });
  } else {
    await chrome.action.setBadgeText({ text: "" });
    await chrome.action.setBadgeBackgroundColor({ color: "#888888" });
    await chrome.action.setTitle({ title: "LotPilot Marketplace Bridge" });
  }
}

function recordResult(ok) {
  recentResults.push(ok);
  if (recentResults.length > 10) recentResults.shift();
  updateBadge().catch((e) => pushLog("error", "badge update failed", { e: String(e) }));
}

// ---------------------------------------------------------------
// POST + retry
// ---------------------------------------------------------------
function backoffMs(attempt) {
  // 1s, 2s, 4s, 8s, 16s, 32s — cap at 60s.
  return Math.min(2 ** attempt * 1000, 60_000);
}

async function postOne(item, cfg) {
  // Build canonical body string ONCE. Sign and send the same bytes.
  const body = JSON.stringify({
    dealer_id: cfg.dealerId,
    marketplace_thread_id: item.payload.marketplace_thread_id,
    buyer_name: item.payload.buyer_name,
    buyer_message: item.payload.buyer_message,
    ...(item.payload.listing_id ? { listing_id: item.payload.listing_id } : {}),
  });
  const signature = await self.LotPilotHmac.signBody(
    cfg.masterSecret,
    cfg.dealerId,
    cfg.secretVersion,
    body,
  );
  const url = cfg.backendUrl.replace(/\/$/, "") + "/api/marketplace/inbound";
  const res = await fetch(url, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      [DEALER_HEADER]: cfg.dealerId,
      [SIGNATURE_HEADER]: signature,
      [VERSION_HEADER]: String(cfg.secretVersion),
    },
    body,
  });
  return res;
}

async function drainQueue() {
  if (draining) return;
  draining = true;
  try {
    const cfg = await loadConfig();
    if (!isConfigComplete(cfg)) {
      pushLog("warn", "drain skipped — config incomplete");
      await updateBadge();
      return;
    }
    let q = await loadQueue();
    const now = Date.now();
    const ready = q.filter((it) => it.nextAttemptAt <= now);
    if (ready.length === 0) {
      // Nothing to do right now; schedule a wake when the next item is due.
      const upcoming = q
        .map((it) => it.nextAttemptAt)
        .sort((a, b) => a - b)[0];
      if (upcoming) {
        const delayMs = Math.max(upcoming - now, 1000);
        chrome.alarms.create("drain", { when: Date.now() + delayMs });
      }
      return;
    }
    for (const item of ready) {
      let res;
      try {
        res = await postOne(item, cfg);
      } catch (err) {
        pushLog("error", "fetch failed", {
          attempts: item.attempts,
          err: String(err),
        });
        item.attempts += 1;
        if (item.attempts >= MAX_ATTEMPTS) {
          pushLog("error", "giving up after max attempts", { id: item.id });
          q = q.filter((x) => x.id !== item.id);
          recordResult(false);
        } else {
          item.nextAttemptAt = Date.now() + backoffMs(item.attempts);
          recordResult(false);
        }
        continue;
      }
      if (res.ok) {
        let parsed = null;
        try { parsed = await res.json(); } catch { /* tolerate */ }
        if (parsed && parsed.kind === "rate_limited") {
          // Backend wants us to back off — see route.ts:206-218.
          const wait = Math.max((parsed.retry_after_sec || 30) * 1000, 5000);
          item.nextAttemptAt = Date.now() + wait;
          item.attempts = Math.min(item.attempts + 1, MAX_ATTEMPTS - 1);
          pushLog("warn", "rate limited; will retry", { wait });
          // rate-limited counts as a NON-failure for badge purposes
          // (we are healthy; just throttled).
          recordResult(true);
          continue;
        }
        pushLog("info", "delivered", { kind: parsed?.kind, id: item.id });
        q = q.filter((x) => x.id !== item.id);
        recordResult(true);
        continue;
      }
      if (res.status === 401 || res.status === 403) {
        pushLog("error", "auth failure — dropping (check popup config)", {
          status: res.status,
        });
        q = q.filter((x) => x.id !== item.id);
        recordResult(false);
        continue;
      }
      if (res.status >= 500 || res.status === 429) {
        item.attempts += 1;
        if (item.attempts >= MAX_ATTEMPTS) {
          pushLog("error", "giving up after max attempts (5xx)", { id: item.id });
          q = q.filter((x) => x.id !== item.id);
        } else {
          item.nextAttemptAt = Date.now() + backoffMs(item.attempts);
        }
        recordResult(false);
        continue;
      }
      // 4xx other than auth — payload is broken, don't retry forever.
      pushLog("error", "bad-request response, dropping", { status: res.status });
      q = q.filter((x) => x.id !== item.id);
      recordResult(false);
    }
    await saveQueue(q);
    if (q.length > 0) {
      chrome.alarms.create("drain", { when: Date.now() + 2000 });
    }
  } finally {
    draining = false;
  }
}

// ---------------------------------------------------------------
// Message + lifecycle wiring
// ---------------------------------------------------------------
chrome.runtime.onMessage.addListener((msg, _sender, sendResponse) => {
  if (!msg || typeof msg !== "object") return false;
  if (msg.type === "marketplace_inbound") {
    enqueue(msg.payload)
      .then(() => drainQueue())
      .catch((e) => pushLog("error", "enqueue failed", { e: String(e) }));
    sendResponse({ ok: true });
    return true;
  }
  if (msg.type === "get_logs") {
    sendResponse({ logs: logRing.slice() });
    return true;
  }
  if (msg.type === "get_status") {
    loadQueue().then((q) =>
      loadConfig().then((cfg) =>
        sendResponse({
          queueSize: q.length,
          recentResults: recentResults.slice(),
          configured: isConfigComplete(cfg),
        }),
      ),
    );
    return true;
  }
  if (msg.type === "force_drain") {
    drainQueue()
      .then(() => sendResponse({ ok: true }))
      .catch((e) => sendResponse({ ok: false, error: String(e) }));
    return true;
  }
  if (msg.type === "health_check") {
    runHealthCheck()
      .then((result) => sendResponse(result))
      .catch((e) => sendResponse({ ok: false, error: String(e) }));
    return true;
  }
  return false;
});

// Single onAlarm dispatcher (Chrome merges multiple listeners but a
// single switch is easier to reason about, and avoids the "alarm fires
// twice and we drain twice" edge case during worker startup races).
chrome.alarms.onAlarm.addListener((alarm) => {
  if (alarm.name === "drain" || alarm.name === "keepalive") {
    drainQueue().catch((e) => pushLog("error", "drain failed", { e: String(e) }));
    if (alarm.name === "keepalive") {
      updateBadge().catch(() => { /* badge errors are non-fatal */ });
    }
  }
});

chrome.runtime.onInstalled.addListener(() => {
  pushLog("info", "extension installed");
  updateBadge();
});

chrome.runtime.onStartup.addListener(() => {
  pushLog("info", "browser startup; resuming drain");
  drainQueue();
  updateBadge();
});

// Periodic drain keepalive — the MV3 worker can be evicted at any
// time; the alarm ticks it back so the queue keeps draining even when
// no FB tab is open.
chrome.alarms.create("keepalive", { periodInMinutes: 1 });

// ---------------------------------------------------------------
// Health check (used by popup button)
// ---------------------------------------------------------------
async function runHealthCheck() {
  const cfg = await loadConfig();
  if (!isConfigComplete(cfg)) {
    return { ok: false, status: 0, reason: "config incomplete" };
  }
  // We send a syntactically-valid payload that the backend will VALIDATE
  // but cannot deliver (the buyer_message is a marker string). The
  // backend will either:
  //  - 200 with kind: "ok"/"pending"/"rate_limited" → HMAC works
  //  - 404 dealer not found → secret correct but dealer id unknown
  //  - 403 → secret wrong
  // Anything in {200, 404} means the wire format is fine.
  const body = JSON.stringify({
    dealer_id: cfg.dealerId,
    marketplace_thread_id: "healthcheck-" + Date.now().toString(36),
    buyer_name: "LotPilot Healthcheck",
    buyer_message: "[lotpilot-extension-healthcheck]",
  });
  const signature = await self.LotPilotHmac.signBody(
    cfg.masterSecret,
    cfg.dealerId,
    cfg.secretVersion,
    body,
  );
  const url = cfg.backendUrl.replace(/\/$/, "") + "/api/marketplace/inbound";
  try {
    const res = await fetch(url, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        [DEALER_HEADER]: cfg.dealerId,
        [SIGNATURE_HEADER]: signature,
        [VERSION_HEADER]: String(cfg.secretVersion),
      },
      body,
    });
    let parsed = null;
    try { parsed = await res.json(); } catch { /* tolerate */ }
    const verdict =
      res.status === 200
        ? "ok"
        : res.status === 404
          ? "dealer-not-found"
          : res.status === 403
            ? "signature-rejected"
            : `http-${res.status}`;
    pushLog("info", "health check complete", { verdict });
    return { ok: res.ok, status: res.status, verdict, body: parsed };
  } catch (err) {
    pushLog("error", "health check failed", { err: String(err) });
    return { ok: false, status: 0, error: String(err) };
  }
}
