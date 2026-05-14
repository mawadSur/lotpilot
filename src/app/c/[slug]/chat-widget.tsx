"use client";

import { useEffect, useRef, useState } from "react";
import type { MessageRole } from "@/lib/db-types";

interface InitialMessage {
  id: string;
  role: MessageRole;
  body: string;
  created_at: string;
}

type SendStatus = "sending" | "sent" | "error";

interface DisplayMessage {
  id: string;
  role: MessageRole;
  body: string;
  status?: SendStatus;
}

interface Props {
  slug: string;
  dealerName: string;
  consentText: string;
  conversationId: string | null;
  initialMessages: InitialMessage[];
}

const MAX_INPUT = 4000;
const POLL_INTERVAL_MS = 6_000;
const POLL_MAX_ATTEMPTS = 50;

export function ChatWidget({
  slug,
  dealerName,
  consentText,
  conversationId: initialConversationId,
  initialMessages,
}: Props) {
  const [messages, setMessages] = useState<DisplayMessage[]>(
    initialMessages.map((m) => ({ id: m.id, role: m.role, body: m.body, status: "sent" })),
  );
  const [conversationId, setConversationId] = useState<string | null>(initialConversationId);
  const [input, setInput] = useState("");
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [polling, setPolling] = useState(false);
  const scrollerRef = useRef<HTMLDivElement | null>(null);
  const lastEverPollRef = useRef<string>(new Date().toISOString());
  // Monotonic counter for client-only message IDs. Avoids Date.now() at
  // call time (the React purity lint rule flags it even from inside an
  // event handler).
  const localIdCounter = useRef<number>(0);

  useEffect(() => {
    const el = scrollerRef.current;
    if (el) el.scrollTop = el.scrollHeight;
  }, [messages, pending]);

  // Pending-approval polling. Stops on new AI message, max attempts, or
  // tab hidden via Page Visibility API.
  useEffect(() => {
    if (!polling || !conversationId) return;
    let attempts = 0;
    let cancelled = false;
    let timer: ReturnType<typeof setTimeout> | null = null;

    function schedule(): void {
      timer = setTimeout(tick, POLL_INTERVAL_MS);
    }

    async function tick(): Promise<void> {
      if (cancelled) return;
      if (document.visibilityState !== "visible") {
        schedule();
        return;
      }
      attempts += 1;
      try {
        const url = new URL("/api/chat/poll", window.location.origin);
        url.searchParams.set("conversationId", conversationId as string);
        url.searchParams.set("since", lastEverPollRef.current);
        const res = await fetch(url.toString(), { credentials: "same-origin" });
        if (res.ok) {
          const data = (await res.json()) as { messages: InitialMessage[] };
          if (data.messages.length > 0) {
            lastEverPollRef.current = data.messages[data.messages.length - 1].created_at;
            setMessages((prev) => [
              ...prev,
              ...data.messages.map((m) => ({
                id: m.id,
                role: m.role,
                body: m.body,
                status: "sent" as const,
              })),
            ]);
            setPolling(false);
            return;
          }
        }
      } catch {
        // ignore network blips during polling
      }
      if (attempts >= POLL_MAX_ATTEMPTS) {
        setPolling(false);
        return;
      }
      schedule();
    }

    schedule();
    return () => {
      cancelled = true;
      if (timer) clearTimeout(timer);
    };
  }, [polling, conversationId]);

  async function send(text: string, replaceId?: string): Promise<void> {
    if (text.length > MAX_INPUT) {
      setError(`Message is too long (max ${MAX_INPUT} characters).`);
      return;
    }

    setError(null);
    setPending(true);

    localIdCounter.current += 1;
    const localId = replaceId ?? `local-${localIdCounter.current}`;
    setMessages((prev) => {
      if (replaceId) {
        return prev.map((m) =>
          m.id === replaceId ? { ...m, status: "sending" } : m,
        );
      }
      return [...prev, { id: localId, role: "buyer", body: text, status: "sending" }];
    });
    if (!replaceId) setInput("");

    try {
      const res = await fetch("/api/chat", {
        method: "POST",
        headers: { "content-type": "application/json" },
        credentials: "same-origin",
        body: JSON.stringify({ slug, conversationId, message: text }),
      });

      if (!res.ok) {
        const data = (await res.json().catch(() => null)) as { error?: string } | null;
        setError(data?.error ?? "Could not reach the dealer right now.");
        setMessages((prev) =>
          prev.map((m) => (m.id === localId ? { ...m, status: "error" } : m)),
        );
        return;
      }

      const data = (await res.json()) as {
        conversationId: string;
        reply: string;
        pendingApproval?: boolean;
      };
      setConversationId(data.conversationId);

      setMessages((prev) => {
        const flipped = prev.map((m) =>
          m.id === localId ? { ...m, status: "sent" as const } : m,
        );
        return [
          ...flipped,
          { id: `ai-${localIdCounter.current}`, role: "ai", body: data.reply, status: "sent" },
        ];
      });

      if (data.pendingApproval) {
        lastEverPollRef.current = new Date().toISOString();
        setPolling(true);
      }
    } catch {
      setError("Network error. Check your connection and try again.");
      setMessages((prev) =>
        prev.map((m) => (m.id === localId ? { ...m, status: "error" } : m)),
      );
    } finally {
      setPending(false);
    }
  }

  async function onSubmit(e: React.FormEvent<HTMLFormElement>): Promise<void> {
    e.preventDefault();
    if (pending) return;
    const text = input.trim();
    if (!text) return;
    await send(text);
  }

  async function onRetry(id: string, text: string): Promise<void> {
    if (pending) return;
    await send(text, id);
  }

  return (
    <div className="mt-4 flex flex-1 flex-col gap-3">
      <div
        ref={scrollerRef}
        className="flex-1 overflow-y-auto rounded-xl border border-zinc-200 bg-white p-4"
        role="log"
        aria-live="polite"
        aria-label={`Conversation with ${dealerName}`}
      >
        {messages.length === 0 ? (
          <Empty dealerName={dealerName} />
        ) : (
          <ul className="flex flex-col gap-3">
            {messages.map((m) => (
              <Bubble
                key={m.id}
                role={m.role}
                body={m.body}
                status={m.status}
                onRetry={() => onRetry(m.id, m.body)}
              />
            ))}
            {pending || polling ? <TypingIndicator /> : null}
          </ul>
        )}
      </div>

      {error ? (
        <p
          role="alert"
          className="rounded-md border border-rose-300 bg-rose-50 px-3 py-2 text-sm text-rose-700"
        >
          {error}
        </p>
      ) : null}

      <form onSubmit={onSubmit} className="flex items-end gap-2">
        <label className="sr-only" htmlFor="lp-chat-input">
          Your message
        </label>
        <textarea
          id="lp-chat-input"
          value={input}
          onChange={(e) => setInput(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === "Enter" && !e.shiftKey) {
              e.preventDefault();
              const form = e.currentTarget.form;
              if (form) form.requestSubmit();
            }
          }}
          rows={2}
          maxLength={MAX_INPUT}
          placeholder="Ask about a vehicle, financing, or a test drive…"
          className="block w-full resize-none rounded-md border border-zinc-300 bg-white px-3 py-2 text-sm text-zinc-900 placeholder-zinc-400 focus:border-amber-500 focus:outline-none focus:ring-2 focus:ring-amber-200"
          disabled={pending}
        />
        <button
          type="submit"
          disabled={pending || input.trim().length === 0}
          className="inline-flex h-10 shrink-0 items-center rounded-md bg-zinc-900 px-4 text-sm font-semibold text-white hover:bg-zinc-800 focus:outline-none focus:ring-2 focus:ring-amber-400 disabled:cursor-not-allowed disabled:opacity-60"
        >
          {pending ? "Sending" : "Send"}
        </button>
      </form>

      <p className="text-[11px] leading-relaxed text-zinc-500">{consentText}</p>
    </div>
  );
}

function Empty({ dealerName }: { dealerName: string }) {
  return (
    <div className="grid h-full place-items-center text-center text-sm text-zinc-500">
      <div className="max-w-xs space-y-2 px-4">
        <p className="text-zinc-700">
          Hi — say hello to {dealerName}. Ask about a specific vehicle, financing, or schedule a test drive.
        </p>
        <p className="text-xs">Replies usually within 60 seconds.</p>
      </div>
    </div>
  );
}

function Bubble({
  role,
  body,
  status,
  onRetry,
}: {
  role: MessageRole;
  body: string;
  status?: SendStatus;
  onRetry: () => void;
}) {
  const isBuyer = role === "buyer";
  return (
    <li
      className={`flex ${isBuyer ? "justify-end" : "justify-start"}`}
      aria-busy={isBuyer && status === "sending"}
    >
      <div
        className="flex max-w-[85%] flex-col items-end"
        aria-invalid={isBuyer && status === "error" ? true : undefined}
      >
        <div
          className={
            isBuyer
              ? status === "error"
                ? "whitespace-pre-wrap rounded-2xl rounded-br-sm border border-rose-300 bg-rose-50 px-3 py-2 text-sm text-rose-900"
                : "whitespace-pre-wrap rounded-2xl rounded-br-sm bg-zinc-900 px-3 py-2 text-sm text-white"
              : "whitespace-pre-wrap rounded-2xl rounded-bl-sm bg-zinc-100 px-3 py-2 text-sm text-zinc-900"
          }
        >
          {body}
        </div>
        {isBuyer && status === "sending" ? (
          <span className="mt-0.5 text-[10px] text-zinc-400">Sending…</span>
        ) : null}
        {isBuyer && status === "sent" ? (
          <span className="mt-0.5 text-[10px] text-zinc-400" aria-hidden>
            sent
          </span>
        ) : null}
        {isBuyer && status === "error" ? (
          <button
            type="button"
            onClick={onRetry}
            className="mt-0.5 text-[10px] font-medium text-rose-600 underline hover:text-rose-700"
          >
            Failed — tap to retry
          </button>
        ) : null}
      </div>
    </li>
  );
}

function TypingIndicator() {
  return (
    <li className="flex justify-start" aria-label="Dealer is replying">
      <div className="inline-flex items-center gap-1 rounded-2xl rounded-bl-sm bg-zinc-100 px-3 py-2 text-sm text-zinc-500">
        <span className="h-1.5 w-1.5 animate-bounce rounded-full bg-zinc-400 [animation-delay:-0.3s]" />
        <span className="h-1.5 w-1.5 animate-bounce rounded-full bg-zinc-400 [animation-delay:-0.15s]" />
        <span className="h-1.5 w-1.5 animate-bounce rounded-full bg-zinc-400" />
      </div>
    </li>
  );
}
