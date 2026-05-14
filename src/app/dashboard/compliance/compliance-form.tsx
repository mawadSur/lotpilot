"use client";

// Compliance export form. Three mutually-exclusive scopes; one
// "Download CSV" button. We POST to a server action that streams the
// CSV via ReadableStream so the browser writes to disk as bytes arrive
// (no full-document buffering). The action also writes the audit row.
//
// We use a plain <form action="/api/dashboard/compliance/export">
// (GET) instead of useActionState so the browser handles the file
// download naturally — server actions return RSC-wrapped responses
// that don't trigger a download, but a route-handler GET returning a
// CSV body with Content-Disposition does.

import { useState } from "react";

type Scope = "conversation_ids" | "date_range" | "dealer_wide";

export function ComplianceForm() {
  const [scope, setScope] = useState<Scope>("date_range");
  const [conversationIds, setConversationIds] = useState("");
  const [startDate, setStartDate] = useState("");
  const [endDate, setEndDate] = useState("");

  // Build a /api/dashboard/compliance/export URL with the chosen
  // params. The action validates everything server-side.
  const buildHref = () => {
    const params = new URLSearchParams();
    params.set("scope", scope);
    if (scope === "conversation_ids") {
      const ids = conversationIds
        .split(/[\s,]+/)
        .map((s) => s.trim())
        .filter(Boolean)
        .join(",");
      params.set("ids", ids);
    } else if (scope === "date_range") {
      if (startDate) params.set("start", startDate);
      if (endDate) params.set("end", endDate);
    }
    return `/api/dashboard/compliance/export?${params.toString()}`;
  };

  const idCount = conversationIds
    .split(/[\s,]+/)
    .map((s) => s.trim())
    .filter(Boolean).length;

  return (
    <form
      method="GET"
      action="/api/dashboard/compliance/export"
      className="grid gap-4 rounded-2xl border border-zinc-200 bg-white p-5"
    >
      <input type="hidden" name="scope" value={scope} />

      <fieldset className="grid gap-2">
        <legend className="text-sm font-semibold">Scope</legend>
        <label className="flex items-start gap-2 text-sm">
          <input
            type="radio"
            name="scope_choice"
            checked={scope === "date_range"}
            onChange={() => setScope("date_range")}
            className="mt-1"
          />
          <span className="grid gap-1">
            <span className="font-medium">Date range</span>
            <span className="text-xs text-zinc-500">
              All conversations created in the selected ISO date range.
            </span>
          </span>
        </label>
        <label className="flex items-start gap-2 text-sm">
          <input
            type="radio"
            name="scope_choice"
            checked={scope === "conversation_ids"}
            onChange={() => setScope("conversation_ids")}
            className="mt-1"
          />
          <span className="grid gap-1">
            <span className="font-medium">Specific conversations</span>
            <span className="text-xs text-zinc-500">
              Paste UUIDs from the inbox URL (one per line or comma-separated).
            </span>
          </span>
        </label>
        <label className="flex items-start gap-2 text-sm">
          <input
            type="radio"
            name="scope_choice"
            checked={scope === "dealer_wide"}
            onChange={() => setScope("dealer_wide")}
            className="mt-1"
          />
          <span className="grid gap-1">
            <span className="font-medium">Everything (last 90 days)</span>
            <span className="text-xs text-zinc-500">
              Every conversation under your dealer in the last 90 days. Capped
              at 10,000 messages; narrow your scope if exceeded.
            </span>
          </span>
        </label>
      </fieldset>

      {scope === "date_range" ? (
        <div className="grid grid-cols-2 gap-3 text-sm">
          <label className="grid gap-1">
            <span className="font-medium">Start</span>
            <input
              type="date"
              name="start"
              value={startDate}
              onChange={(e) => setStartDate(e.target.value)}
              className="h-10 rounded-md border border-zinc-300 px-3"
            />
          </label>
          <label className="grid gap-1">
            <span className="font-medium">End</span>
            <input
              type="date"
              name="end"
              value={endDate}
              onChange={(e) => setEndDate(e.target.value)}
              className="h-10 rounded-md border border-zinc-300 px-3"
            />
          </label>
        </div>
      ) : null}

      {scope === "conversation_ids" ? (
        <label className="grid gap-1 text-sm">
          <span className="font-medium">Conversation UUIDs</span>
          <textarea
            name="ids"
            rows={4}
            value={conversationIds}
            onChange={(e) => setConversationIds(e.target.value)}
            placeholder="e.g. 11111111-1111-4111-8111-111111111111"
            className="rounded-md border border-zinc-300 px-3 py-2 font-mono text-xs"
          />
          <span className="text-[10px] uppercase tracking-wide text-zinc-500">
            {idCount} ID{idCount === 1 ? "" : "s"} parsed
          </span>
        </label>
      ) : null}

      <div>
        <button
          type="submit"
          formAction={buildHref()}
          className="inline-flex h-10 items-center justify-center rounded-md bg-zinc-900 px-5 text-sm font-semibold text-white hover:bg-zinc-800"
        >
          Download CSV
        </button>
      </div>
    </form>
  );
}
