// In-process mock of the slice of @supabase/supabase-js that
// chat-pipeline.ts (+ conversation-router.ts + consent-capture.ts)
// actually uses. Backed by JS Maps so a test can seed a dealer +
// conversation, run runChatTurn, and inspect the resulting rows
// without spinning up a real Supabase.
//
// vi.mock here is hoisted to the top of any test file that imports
// from this module — so the mocks are in place BEFORE chat-pipeline.ts
// is imported. (See setup.ts header comment for why we don't put
// vi.mock in setup.ts.)
//
// What this DOES cover (per chat-pipeline.ts call sites):
//   - .from("messages").insert({...})
//   - .from("messages").select("...", {count, head}).eq().eq()
//   - .from("messages").select("role,body,...").eq().or().order().limit()
//   - .from("vehicles").select("*").eq().eq().order().limit()
//   - .from("messages").insert({...}).select("id").single()
//   - .from("messages").update({...}).eq()
//   - .from("conversations").update({...}).eq()
//   - .from("keyword_events").insert({...})
//   - .from("consents").insert({...})
//
// What it does NOT cover: views, RPC, RLS, foreign-key cascades. None
// of that is exercised by the chat pipeline in-process.
//
// The chainable QueryBuilder/InsertBuilder/UpdateBuilder live in
// mock-sb-builder.ts to keep this file under the 500-line cap.

import {
  InsertBuilder,
  QueryBuilder,
  UpdateBuilder,
  type TableResolver,
} from "./mock-sb-builder";
import type {
  ConversationRow,
  DealerRow,
  FollowUpJobRow,
  LeadShareRow,
  MessageRow,
} from "../../src/lib/db-types";

// ---------------------------------------------------------------------
// Storage

interface ConsentRowMock {
  id: string;
  dealer_id: string;
  conversation_id: string;
  channel: string;
  consent_text: string;
  ip_address: string | null;
  user_agent: string | null;
  buyer_phone: string | null;
  created_at: string;
}

interface KeywordEventRowMock {
  id: string;
  dealer_id: string;
  conversation_id: string;
  keyword: string;
  channel: string;
  raw_message: string;
  created_at: string;
}

export interface MockStore {
  dealers: Map<string, DealerRow>;
  conversations: Map<string, ConversationRow>;
  messages: Map<string, MessageRow>;
  consents: Map<string, ConsentRowMock>;
  keyword_events: Map<string, KeywordEventRowMock>;
  vehicles: Map<string, Record<string, unknown>>;
  follow_up_jobs: Map<string, FollowUpJobRow>;
  lead_shares: Map<string, LeadShareRow>;
}

let store: MockStore = freshStore();

function freshStore(): MockStore {
  return {
    dealers: new Map(),
    conversations: new Map(),
    messages: new Map(),
    consents: new Map(),
    keyword_events: new Map(),
    vehicles: new Map(),
    follow_up_jobs: new Map(),
    lead_shares: new Map(),
  };
}

export function resetStore(): void {
  store = freshStore();
}

export function getStore(): MockStore {
  return store;
}

// ---------------------------------------------------------------------
// Seeding helpers

let counter = 0;
function nextId(prefix: string): string {
  counter += 1;
  // UUID-shaped so the calendly webhook's UUID_RE smoke check passes.
  // 8-4-4-4-12 hex; we hex-encode the counter.
  const hex = counter.toString(16).padStart(8, "0");
  return `${prefix.padStart(8, "0").slice(0, 8)}-0000-4000-8000-${hex.padStart(12, "0")}`;
}

export function seedDealer(overrides: Partial<DealerRow> = {}): DealerRow {
  const id = nextId("aaaaaaaa");
  const dealer: DealerRow = {
    id,
    owner_user_id: nextId("bbbbbbbb"),
    slug: `test-dealer-${counter}`,
    name: "Test Dealer",
    signature: null,
    business_hours: {
      mon: ["09:00", "18:00"],
      tue: ["09:00", "18:00"],
      wed: ["09:00", "18:00"],
      thu: ["09:00", "18:00"],
      fri: ["09:00", "18:00"],
      sat: ["10:00", "16:00"],
      sun: null,
    },
    calendly_url: null,
    timezone: "America/New_York",
    approve_before_send: false,
    sms_number: null,
    voice_number: null,
    calendly_event_type_uri: null,
    whatsapp_number: null,
    zip: null,
    zip3: null,
    auto_confirm_enabled: true,
    onboarded_at: new Date().toISOString(),
    created_at: new Date().toISOString(),
    updated_at: new Date().toISOString(),
    ...overrides,
  };
  store.dealers.set(dealer.id, dealer);
  return dealer;
}

export function seedConversation(
  dealer: DealerRow,
  overrides: Partial<ConversationRow> = {},
): ConversationRow {
  const id = nextId("cccccccc");
  const conversation: ConversationRow = {
    id,
    dealer_id: dealer.id,
    buyer_session: `web:test-session-${counter}-padded-with-bytes`,
    language: "en",
    status: "open",
    last_intent: null,
    lead_status: "new",
    notes: null,
    assigned_user_id: null,
    channel: "web",
    buyer_phone: null,
    suppressed_at: null,
    scheduled_at: null,
    lead_score: null,
    buyer_intent_make: null,
    buyer_intent_model: null,
    buyer_intent_body_type: null,
    test_drive_status: null,
    forked_from_conversation_id: null,
    created_at: new Date().toISOString(),
    updated_at: new Date().toISOString(),
    ...overrides,
  };
  store.conversations.set(conversation.id, conversation);
  return conversation;
}

// ---------------------------------------------------------------------
// Builder Proxy. Wraps a single table-scoped builder so the same `from`
// call returns an object that has the QueryBuilder read surface plus
// insert/update factories. Translation of the real PostgrestQueryBuilder
// into our split-class shape.

const tableResolver: TableResolver = (name) => {
  switch (name) {
    case "dealers":
      return store.dealers as unknown as Map<string, Record<string, unknown>>;
    case "conversations":
      return store.conversations as unknown as Map<string, Record<string, unknown>>;
    case "messages":
      return store.messages as unknown as Map<string, Record<string, unknown>>;
    case "consents":
      return store.consents as unknown as Map<string, Record<string, unknown>>;
    case "keyword_events":
      return store.keyword_events as unknown as Map<string, Record<string, unknown>>;
    case "vehicles":
      return store.vehicles;
    case "follow_up_jobs":
      return store.follow_up_jobs as unknown as Map<string, Record<string, unknown>>;
    case "lead_shares":
      return store.lead_shares as unknown as Map<string, Record<string, unknown>>;
    default:
      throw new Error(`mock-pipeline: unknown table ${name}`);
  }
};

export interface MockSupabase {
  from(table: string): {
    select: QueryBuilder["select"];
    insert(payload: Record<string, unknown> | Record<string, unknown>[]): InsertBuilder;
    update(patch: Record<string, unknown>): UpdateBuilder;
    eq: QueryBuilder["eq"];
    in: QueryBuilder["in"];
    not: QueryBuilder["not"];
    gt: QueryBuilder["gt"];
    ilike: QueryBuilder["ilike"];
    or: QueryBuilder["or"];
    order: QueryBuilder["order"];
    limit: QueryBuilder["limit"];
    maybeSingle: QueryBuilder["maybeSingle"];
    single: QueryBuilder["single"];
    then: QueryBuilder["then"];
  };
}

export function makeMockSb(): MockSupabase {
  const mintId = () => nextId("dddddddd");
  return {
    from(table: string) {
      const builder = new QueryBuilder(table, tableResolver);
      return new Proxy(builder as unknown as Record<string, unknown>, {
        get(target, prop, receiver) {
          if (prop === "insert") {
            return (payload: Record<string, unknown> | Record<string, unknown>[]) =>
              new InsertBuilder(
                table,
                Array.isArray(payload) ? payload : [payload],
                tableResolver,
                mintId,
              );
          }
          if (prop === "update") {
            return (patch: Record<string, unknown>) =>
              new UpdateBuilder(table, patch, tableResolver);
          }
          return Reflect.get(target, prop, receiver);
        },
      }) as unknown as ReturnType<MockSupabase["from"]>;
    },
  };
}

// ---------------------------------------------------------------------
// Claude reply override. Tests call claudeMock.set({...}) to swap the
// canned response runChatTurn will see; the per-test vi.mock factory
// in each test file pipes claudeMock.current through to the spy.

export type ClaudeReplyOverride = {
  reply: string;
  intent: "test_drive" | "financing" | "trade_in" | "general" | "ready_to_close";
  language: "en" | "es";
  offered_calendly: boolean;
  // v0.7.3: chat-pipeline patches conversations.buyer_intent_* on every
  // AI turn (first-write-wins). The mock must surface the same shape
  // callClaude does so the patch logic doesn't NPE — defaults to all
  // null (no buyer intent surfaced).
  buyer_intent?: {
    make: string | null;
    model: string | null;
    body_type: string | null;
  };
  usage?: { input_tokens: number; output_tokens: number };
};

const claudeStub = {
  reply: "Sure thing — happy to help.",
  intent: "general" as ClaudeReplyOverride["intent"],
  language: "en" as ClaudeReplyOverride["language"],
  offered_calendly: false,
  buyer_intent: { make: null, model: null, body_type: null },
  usage: { input_tokens: 100, output_tokens: 60 },
};

export const claudeMock = {
  current: { ...claudeStub },
  reset(): void {
    Object.assign(this.current, claudeStub);
  },
  set(override: Partial<ClaudeReplyOverride>): void {
    Object.assign(this.current, override);
    if (!override.usage) this.current.usage = claudeStub.usage;
  },
};
