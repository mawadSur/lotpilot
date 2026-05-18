// LotPilot Marketplace Bridge — popup script.
//
// Loads config from chrome.storage.local, writes it back on Save, and
// drives the health-check button + log feed. The popup talks to the
// background service worker via chrome.runtime.sendMessage.

(function () {
  "use strict";

  const $ = (id) => document.getElementById(id);

  const els = {
    backendUrl: $("backendUrl"),
    dealerId: $("dealerId"),
    masterSecret: $("masterSecret"),
    secretVersion: $("secretVersion"),
    saveBtn: $("saveBtn"),
    healthBtn: $("healthBtn"),
    refreshLogs: $("refreshLogs"),
    status: $("status"),
    statusList: $("statusList"),
    logs: $("logs"),
  };

  function setStatus(text, level) {
    els.status.textContent = text || "";
    els.status.className = "status" + (level ? " " + level : "");
  }

  function validateConfig(cfg) {
    if (!cfg.backendUrl || !/^https?:\/\//i.test(cfg.backendUrl)) {
      return "Backend URL must start with http:// or https://";
    }
    if (!self.LotPilotHmac.UUID_RE.test(cfg.dealerId)) {
      return "Dealer ID must be a UUID";
    }
    if (!cfg.masterSecret || cfg.masterSecret.length < 16) {
      return "Master Secret looks too short";
    }
    if (!Number.isInteger(cfg.secretVersion) || cfg.secretVersion < 1) {
      return "Secret Version must be an integer >= 1";
    }
    return null;
  }

  function readForm() {
    return {
      backendUrl: els.backendUrl.value.trim(),
      dealerId: els.dealerId.value.trim(),
      masterSecret: els.masterSecret.value,
      secretVersion: Number.parseInt(els.secretVersion.value, 10) || 1,
    };
  }

  function loadInto() {
    chrome.storage.local.get(
      ["backendUrl", "dealerId", "masterSecret", "secretVersion"],
      (res) => {
        els.backendUrl.value = res?.backendUrl || "";
        els.dealerId.value = res?.dealerId || "";
        els.masterSecret.value = res?.masterSecret || "";
        els.secretVersion.value = String(res?.secretVersion || 1);
      },
    );
  }

  function save() {
    const cfg = readForm();
    const err = validateConfig(cfg);
    if (err) {
      setStatus(err, "err");
      return;
    }
    chrome.storage.local.set(cfg, () => {
      setStatus("Saved.", "ok");
      refreshStatus();
    });
  }

  function refreshStatus() {
    chrome.runtime.sendMessage({ type: "get_status" }, (res) => {
      if (!res) {
        els.statusList.innerHTML = "";
        return;
      }
      const rows = [
        ["Configured", res.configured ? "yes" : "no"],
        ["Queue size", String(res.queueSize)],
        [
          "Last 10 results",
          res.recentResults
            .map((r) => (r ? "ok" : "fail"))
            .join(", ") || "(none)",
        ],
      ];
      els.statusList.innerHTML = rows
        .map(
          ([k, v]) =>
            `<li><span>${escapeHtml(k)}</span><span>${escapeHtml(v)}</span></li>`,
        )
        .join("");
    });
  }

  function refreshLogs() {
    chrome.runtime.sendMessage({ type: "get_logs" }, (res) => {
      const logs = res?.logs || [];
      if (logs.length === 0) {
        els.logs.textContent = "(no activity yet)";
        return;
      }
      els.logs.innerHTML = logs
        .slice(-50)
        .map((entry) => {
          const klass =
            entry.level === "error"
              ? "err"
              : entry.level === "warn"
                ? "warn"
                : "";
          const extra = entry.extra ? " " + JSON.stringify(entry.extra) : "";
          return `<div class="entry ${klass}">${escapeHtml(
            entry.ts.slice(11, 19),
          )} ${escapeHtml(entry.level)} ${escapeHtml(
            entry.message,
          )}${escapeHtml(extra)}</div>`;
        })
        .join("");
      els.logs.scrollTop = els.logs.scrollHeight;
    });
  }

  function runHealth() {
    setStatus("Running health check…", "warn");
    els.healthBtn.disabled = true;
    chrome.runtime.sendMessage({ type: "health_check" }, (res) => {
      els.healthBtn.disabled = false;
      if (!res) {
        setStatus("No response from background script.", "err");
        return;
      }
      if (res.ok) {
        setStatus(
          `OK (${res.verdict || "unknown"}, status ${res.status})`,
          "ok",
        );
      } else {
        const detail =
          res.verdict || res.error || res.reason || `status ${res.status}`;
        setStatus(`Failed: ${detail}`, "err");
      }
      refreshLogs();
      refreshStatus();
    });
  }

  function escapeHtml(s) {
    return String(s)
      .replace(/&/g, "&amp;")
      .replace(/</g, "&lt;")
      .replace(/>/g, "&gt;")
      .replace(/"/g, "&quot;");
  }

  // Wire up.
  els.saveBtn.addEventListener("click", save);
  els.healthBtn.addEventListener("click", runHealth);
  els.refreshLogs.addEventListener("click", () => {
    refreshLogs();
    refreshStatus();
  });

  document.addEventListener("DOMContentLoaded", () => {
    loadInto();
    refreshLogs();
    refreshStatus();
  });
  // DOMContentLoaded may already have fired by the time scripts run.
  if (document.readyState !== "loading") {
    loadInto();
    refreshLogs();
    refreshStatus();
  }
})();
