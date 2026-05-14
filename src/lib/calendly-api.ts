// Calendly REST API helper. v0.5 uses this to resolve an event_type URI
// to its owning user (and via that, our dealer row) BEFORE falling back
// to the v0.4 slug-substring heuristic. The heuristic is exact for a
// one-dealer-per-Calendly-account world but ambiguous when two
// dealers happen to share a slug substring; the real API closes that
// gap.
//
// Cache strategy: the webhook caches the dealer's event_type_uri on the
// dealers row after the first successful lookup (v0.5 migration 0007).
// Steady state, calendly_event_type_uri is set, the webhook hits a
// local equality lookup, and we never call this helper again.
//
// Failure mode: any non-2xx, abort, or shape mismatch returns null. The
// caller (resolveDealer) then falls through to the v0.4 heuristic. We
// deliberately do NOT throw — webhooks must always 200 after signature
// passes (Calendly retries non-2xx forever).

import { calendlyApiConfigured, requireCalendlyApiKey } from "./env";
import { log } from "./log";

const CALENDLY_API_HOST = "https://api.calendly.com";
const TIMEOUT_MS = 5000;
const MAX_ATTEMPTS = 2;
const RETRY_BACKOFF_MS = 250;

export interface EventTypeOwner {
  // The Calendly user_uri owning this event type. Shape:
  //   https://api.calendly.com/users/<id>
  ownerUri: string;
  // The user-facing slug (not the user_uri). Useful for joining against
  // dealers.calendly_url, which stores the public-facing URL form
  // https://calendly.com/<user_slug>/<event_slug>.
  ownerSlug: string;
  // Event-type display name. Surfaced in logs only.
  name: string;
}

interface CalendlyEventTypeResponse {
  resource?: {
    name?: string;
    profile?: {
      owner?: string;
    };
    scheduling_url?: string;
  };
}

/**
 * Fetch the owner of a Calendly event type.
 *
 * @param eventTypeUri - canonical URI: https://api.calendly.com/event_types/<id>
 * @returns owner info on success, null on failure (any non-2xx, timeout,
 *   shape mismatch, or missing API key). Never throws.
 */
export async function lookupEventTypeOwner(
  eventTypeUri: string,
): Promise<EventTypeOwner | null> {
  if (!calendlyApiConfigured) return null;

  let key: string;
  try {
    key = requireCalendlyApiKey();
  } catch {
    return null;
  }

  for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt += 1) {
    const result = await callOnce(eventTypeUri, key);
    if (result.kind === "ok") return result.value;
    // Don't retry on 4xx — they're terminal (auth, not-found, malformed).
    if (result.kind === "client_error") {
      log.warn("calendly_api.client_error", { attempt, status: result.status });
      return null;
    }
    if (attempt < MAX_ATTEMPTS) {
      await sleep(RETRY_BACKOFF_MS);
    } else {
      log.warn("calendly_api.exhausted", {
        attempts: attempt,
        kind: result.kind,
        detail: result.detail,
      });
    }
  }
  return null;
}

type CallResult =
  | { kind: "ok"; value: EventTypeOwner }
  | { kind: "client_error"; status: number }
  | { kind: "server_error"; status: number; detail?: string }
  | { kind: "abort"; detail: string }
  | { kind: "shape"; detail: string }
  | { kind: "unreachable"; detail: string };

async function callOnce(eventTypeUri: string, apiKey: string): Promise<CallResult> {
  const id = extractEventTypeId(eventTypeUri);
  if (!id) {
    return { kind: "shape", detail: "could_not_extract_event_type_id" };
  }
  const url = `${CALENDLY_API_HOST}/event_types/${encodeURIComponent(id)}`;

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), TIMEOUT_MS);
  try {
    const res = await fetch(url, {
      method: "GET",
      headers: {
        Authorization: `Bearer ${apiKey}`,
        "Content-Type": "application/json",
      },
      signal: controller.signal,
    });
    if (res.status >= 400 && res.status < 500) {
      return { kind: "client_error", status: res.status };
    }
    if (res.status >= 500) {
      return { kind: "server_error", status: res.status };
    }
    const json = (await res.json()) as CalendlyEventTypeResponse;
    const ownerUri = json.resource?.profile?.owner;
    const name = json.resource?.name ?? "";
    const schedulingUrl = json.resource?.scheduling_url;
    if (!ownerUri || typeof ownerUri !== "string") {
      return { kind: "shape", detail: "missing_owner_uri" };
    }
    const ownerSlug = extractOwnerSlug(schedulingUrl, ownerUri);
    return {
      kind: "ok",
      value: { ownerUri, ownerSlug, name },
    };
  } catch (err) {
    const e = err as Error;
    if (e.name === "AbortError") {
      return { kind: "abort", detail: "timeout" };
    }
    return { kind: "unreachable", detail: e.message };
  } finally {
    clearTimeout(timer);
  }
}

function extractEventTypeId(uri: string): string | null {
  const match = /^https:\/\/api\.calendly\.com\/event_types\/([A-Za-z0-9-]+)$/.exec(uri);
  return match ? match[1] : null;
}

// Pulls the user-slug off scheduling_url (preferred — matches what the
// dealer pasted into calendly_url). Falls back to the trailing segment
// of the owner_uri when scheduling_url isn't present (it should always
// be present per Calendly v2; defensive programming).
function extractOwnerSlug(schedulingUrl: string | undefined, ownerUri: string): string {
  if (schedulingUrl) {
    try {
      const u = new URL(schedulingUrl);
      const first = u.pathname.replace(/^\/+/, "").split("/")[0]?.trim();
      if (first) return first;
    } catch {
      // fall through
    }
  }
  const tail = ownerUri.split("/").pop() ?? "";
  return tail.trim();
}

function sleep(ms: number): Promise<void> {
  return new Promise((res) => setTimeout(res, ms));
}
