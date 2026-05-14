"use client";

// Marketplace per-dealer secret tile. Click-to-reveal pattern so the
// secret doesn't ride along in the rendered HTML — only after an
// explicit user gesture does the client fetch /api/dashboard/
// marketplace/secret and surface it.
//
// The audit row (system_warnings kind='marketplace_secret_disclosed')
// is written server-side every time the endpoint is hit; the dealer
// will see it in their warnings banner — that's intentional, the
// dealer should be aware whenever their secret is read out (and roll
// the master if they didn't initiate the read).

import { useState, useTransition } from "react";

interface SecretResponse {
  dealer_id: string;
  secret: string;
}

export function MarketplaceSecretTile({ dealerId }: { dealerId: string }) {
  const [secret, setSecret] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [pending, startTransition] = useTransition();
  const [copied, setCopied] = useState<"id" | "secret" | null>(null);

  const reveal = () => {
    setError(null);
    startTransition(async () => {
      try {
        const res = await fetch("/api/dashboard/marketplace/secret");
        if (!res.ok) {
          setError(
            res.status === 503
              ? "Marketplace is not configured on this deploy."
              : res.status === 429
                ? "Too many reveals — try again in a minute."
                : "Could not load the secret.",
          );
          return;
        }
        const payload = (await res.json()) as SecretResponse;
        setSecret(payload.secret);
      } catch {
        setError("Network error. Try again.");
      }
    });
  };

  const copyText = async (label: "id" | "secret", text: string) => {
    try {
      await navigator.clipboard.writeText(text);
      setCopied(label);
      window.setTimeout(() => setCopied((cur) => (cur === label ? null : cur)), 1500);
    } catch {
      // Clipboard API blocked (insecure context) — fall back silently.
    }
  };

  return (
    <div className="grid gap-3 text-sm">
      <p className="text-xs text-zinc-600">
        Paste these into the LotPilot Marketplace browser extension at
        install time. The extension HMAC-signs every inbound message with
        the secret; LotPilot derives the same value from the master
        secret on the server.
      </p>

      <KvRow label="Dealer ID" value={dealerId} onCopy={() => copyText("id", dealerId)} copied={copied === "id"} />

      {secret ? (
        <KvRow
          label="Extension secret"
          value={secret}
          onCopy={() => copyText("secret", secret)}
          copied={copied === "secret"}
          mono
        />
      ) : (
        <button
          type="button"
          onClick={reveal}
          disabled={pending}
          className="inline-flex h-10 items-center justify-center self-start rounded-md border border-zinc-300 bg-white px-3 text-xs font-semibold text-zinc-900 hover:bg-zinc-50 disabled:cursor-not-allowed disabled:opacity-60"
        >
          {pending ? "Loading…" : "Reveal extension secret"}
        </button>
      )}

      {error ? (
        <p
          role="alert"
          className="rounded-md border border-rose-300 bg-rose-50 px-3 py-2 text-xs text-rose-700"
        >
          {error}
        </p>
      ) : null}
      <p className="text-[10px] uppercase tracking-wide text-zinc-500">
        Revealing the secret logs a warning to your dashboard — roll the
        master secret if you didn&rsquo;t initiate the read.
      </p>
    </div>
  );
}

function KvRow({
  label,
  value,
  onCopy,
  copied,
  mono,
}: {
  label: string;
  value: string;
  onCopy: () => void;
  copied: boolean;
  mono?: boolean;
}) {
  return (
    <div className="grid gap-1">
      <span className="text-xs font-medium text-zinc-700">{label}</span>
      <div className="flex items-stretch gap-2">
        <code
          className={
            "flex-1 break-all rounded-md border border-zinc-200 bg-zinc-50 px-3 py-2 text-xs text-zinc-800 " +
            (mono ? "font-mono" : "font-mono")
          }
        >
          {value}
        </code>
        <button
          type="button"
          onClick={onCopy}
          className="inline-flex h-auto items-center rounded-md border border-zinc-300 bg-white px-2 text-[10px] font-semibold uppercase tracking-wide text-zinc-700 hover:bg-zinc-50"
        >
          {copied ? "Copied" : "Copy"}
        </button>
      </div>
    </div>
  );
}
