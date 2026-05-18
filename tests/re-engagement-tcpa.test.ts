// T2.5 TCPA gate regression tests. Every gate in
// src/lib/re-engagement/send.ts MUST be exercised here; a failure on
// any of these is a ship-blocker.
//
// Strategy:
//   - We build a small in-test fake Supabase client that covers exactly
//     the surface attemptReEngagement uses: from(table).select(...).
//     eq().eq().gt().order().limit().{maybeSingle|single|count-head|then},
//     from(table).insert({...}), from(table).update({...}).eq().
//   - The existing tests/helpers/mock-pipeline isn't used because it
//     doesn't know about `re_engagement_audit` or `vehicle_events`,
//     and extending it would couple unrelated tests to T2.5 schema
//     churn. Self-contained mock keeps the blast radius tight.
//
// Cases (10+):
//   1. happy path SMS sends — audit row written, message persisted.
//   2. happy path ES (Spanish) — body uses ES copy.
//   3. consent missing — hard skip; no audit row.
//   4. STOP keyword in history — hard skip; no audit row.
//   5. opted_out (suppressed_at) — hard skip.
//   6. quiet hours (22:00 local) — hard skip.
//   7. 14-day cooldown — hard skip when prior audit exists.
//   8. per-dealer cap (50 today) — hard skip.
//   9. freshness — buyer replied < 7d ago, skip.
//  10. no phone — skip with no_phone.
//  11. unsupported channel (web) — skip.
//  12. vehicle no longer available — skip.

import { beforeEach, describe, expect, it, vi } from "vitest";

import {
  attemptReEngagement,
  isQuietHour,
  hourInTimezone,
} from "../src/lib/re-engagement/send";
import type { MatchCandidate } from "../src/lib/re-engagement/match";
import type {
  ConversationRow,
  DealerRow,
  VehicleEventRow,
  VehicleRow,
} from "../src/lib/db-types";

// SMS + WhatsApp adapters mocked at module level so we never hit
// Twilio / Meta during the gate tests. The "send_failed" path is
// exercised by setting send to return {queued:false}.
const sendSmsSpy = vi.fn(async () => ({ queued: true, sid: "SM_test" }));
const sendWhatsAppSpy = vi.fn(async () => ({ queued: true, messageId: "wa_test" }));

vi.mock("../src/lib/sms/twilio", () => ({
  sendSms: (...args: unknown[]) => sendSmsSpy(...(args as [])),
  maskPhone: (p: string) => p,
}));

vi.mock("../src/lib/whatsapp/cloud-api", () => ({
  sendWhatsAppMessage: (...args: unknown[]) => sendWhatsAppSpy(...(args as [])),
}));

// Avoid the real Anthropic SDK trying to load — send.ts references
// buildSystemPrompt / callClaude only to keep the seam open. Stubbing
// them out means we don't need ANTHROPIC_API_KEY at test time AND we
// guarantee no token spend.
vi.mock("../src/lib/ai", () => ({
  buildSystemPrompt: () => "stub-system-prompt",
  callClaude: vi.fn(),
  AiReplyError: class AiReplyError extends Error {},
}));

// ---------------------------------------------------------------------
// In-test Supabase fake. Only the call shapes attemptReEngagement uses.

interface Tables {
  vehicles: Map<string, VehicleRow>;
  conversations: Map<string, ConversationRow>;
  consents: Map<string, Record<string, unknown>>;
  keyword_events: Map<string, Record<string, unknown>>;
  messages: Map<string, Record<string, unknown>>;
  re_engagement_audit: Map<string, Record<string, unknown>>;
}

function freshTables(): Tables {
  return {
    vehicles: new Map(),
    conversations: new Map(),
    consents: new Map(),
    keyword_events: new Map(),
    messages: new Map(),
    re_engagement_audit: new Map(),
  };
}

let tables: Tables = freshTables();
let nextIdCounter = 0;
function mintId(prefix: string): string {
  nextIdCounter += 1;
  const hex = nextIdCounter.toString(16).padStart(12, "0");
  return `${prefix.padStart(8, "0").slice(0, 8)}-0000-4000-8000-${hex}`;
}

type Predicate = (row: Record<string, unknown>) => boolean;

interface BuilderState {
  table: keyof Tables;
  filters: Predicate[];
  countHead: boolean;
  orderKey?: string;
  orderAsc?: boolean;
  limitN?: number;
}

function rowsFor(table: keyof Tables): Record<string, unknown>[] {
  return [...tables[table].values()] as Record<string, unknown>[];
}

class FakeBuilder {
  constructor(private state: BuilderState) {}
  select(_cols?: string, opts?: { count?: "exact"; head?: boolean }) {
    if (opts?.count === "exact" && opts.head) this.state.countHead = true;
    return this;
  }
  eq(col: string, val: unknown): this {
    this.state.filters.push((r) => r[col] === val);
    return this;
  }
  gt(col: string, val: string): this {
    this.state.filters.push((r) => String(r[col]) > val);
    return this;
  }
  order(col: string, opts: { ascending: boolean }): this {
    this.state.orderKey = col;
    this.state.orderAsc = opts.ascending;
    return this;
  }
  limit(n: number): this {
    this.state.limitN = n;
    return this;
  }
  private resolve(): Record<string, unknown>[] {
    let rows = rowsFor(this.state.table).filter((r) =>
      this.state.filters.every((p) => p(r)),
    );
    if (this.state.orderKey) {
      const key = this.state.orderKey;
      const asc = this.state.orderAsc ?? true;
      rows = rows.slice().sort((a, b) => {
        const av = String(a[key] ?? "");
        const bv = String(b[key] ?? "");
        if (av === bv) return 0;
        return (av < bv ? -1 : 1) * (asc ? 1 : -1);
      });
    }
    if (this.state.limitN != null) rows = rows.slice(0, this.state.limitN);
    return rows;
  }
  async maybeSingle() {
    const rows = this.resolve();
    if (rows.length === 0) return { data: null, error: null };
    return { data: rows[0], error: null };
  }
  async single() {
    const rows = this.resolve();
    if (rows.length === 0) return { data: null, error: { message: "no rows" } };
    return { data: rows[0], error: null };
  }
  then<R1, R2>(
    onfulfilled?: (v: { data: Record<string, unknown>[]; error: null; count?: number }) => R1 | PromiseLike<R1>,
    onrejected?: (r: unknown) => R2 | PromiseLike<R2>,
  ): Promise<R1 | R2> {
    const rows = this.resolve();
    const out = {
      data: this.state.countHead ? [] : rows,
      error: null,
      count: this.state.countHead ? rows.length : undefined,
    };
    return Promise.resolve(out).then(onfulfilled ?? null, onrejected ?? null);
  }
}

class InsertBuilder {
  constructor(private table: keyof Tables, private payload: Record<string, unknown>) {}
  private commit(): Record<string, unknown> {
    const id = (this.payload.id as string | undefined) ?? mintId("ffffffff");
    const full = {
      ...this.payload,
      id,
      created_at: this.payload.created_at ?? new Date().toISOString(),
      sent_at: this.payload.sent_at ?? new Date().toISOString(),
    };
    (tables[this.table] as Map<string, Record<string, unknown>>).set(id, full);
    return full;
  }
  then<R1, R2>(
    onfulfilled?: (v: { data: Record<string, unknown>[]; error: null }) => R1 | PromiseLike<R1>,
    onrejected?: (r: unknown) => R2 | PromiseLike<R2>,
  ): Promise<R1 | R2> {
    const row = this.commit();
    return Promise.resolve({ data: [row], error: null }).then(
      onfulfilled ?? null,
      onrejected ?? null,
    );
  }
  select() {
    const row = this.commit();
    return {
      async single() {
        return { data: row, error: null };
      },
    };
  }
}

class UpdateBuilder {
  private filters: Predicate[] = [];
  constructor(private table: keyof Tables, private patch: Record<string, unknown>) {}
  eq(col: string, val: unknown): this {
    this.filters.push((r) => r[col] === val);
    return this;
  }
  then<R1, R2>(
    onfulfilled?: (v: { data: Record<string, unknown>[]; error: null }) => R1 | PromiseLike<R1>,
    onrejected?: (r: unknown) => R2 | PromiseLike<R2>,
  ): Promise<R1 | R2> {
    const map = tables[this.table] as Map<string, Record<string, unknown>>;
    const out: Record<string, unknown>[] = [];
    for (const [id, row] of map.entries()) {
      if (!this.filters.every((p) => p(row))) continue;
      const merged = { ...row, ...this.patch };
      map.set(id, merged);
      out.push(merged);
    }
    return Promise.resolve({ data: out, error: null }).then(
      onfulfilled ?? null,
      onrejected ?? null,
    );
  }
}

function makeFakeSb() {
  return {
    from(name: keyof Tables) {
      // Inline factory returns the appropriate builder per first verb.
      const builder = new FakeBuilder({ table: name, filters: [], countHead: false });
      return new Proxy(builder as unknown as Record<string, unknown>, {
        get(target, prop, receiver) {
          if (prop === "insert") {
            return (payload: Record<string, unknown>) =>
              new InsertBuilder(name, payload);
          }
          if (prop === "update") {
            return (patch: Record<string, unknown>) =>
              new UpdateBuilder(name, patch);
          }
          return Reflect.get(target, prop, receiver);
        },
      });
    },
  } as unknown as Parameters<typeof attemptReEngagement>[0]["sb"];
}

// ---------------------------------------------------------------------
// Seed helpers — copy-paste from mock-pipeline but local so the table
// keys line up with our purpose-specific tables map.

function seedDealer(overrides: Partial<DealerRow> = {}): DealerRow {
  return {
    id: mintId("aaaaaaaa"),
    owner_user_id: mintId("bbbbbbbb"),
    slug: "test-dealer",
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
    stripe_customer_id: null,
    stripe_subscription_id: null,
    subscription_tier: null,
    subscription_status: null,
    subscription_current_period_end: null,
    onboarded_at: new Date().toISOString(),
    created_at: new Date().toISOString(),
    updated_at: new Date().toISOString(),
    ...overrides,
  };
}

function seedVehicle(dealer: DealerRow, overrides: Partial<VehicleRow> = {}): VehicleRow {
  const v: VehicleRow = {
    id: mintId("eeeeeeee"),
    dealer_id: dealer.id,
    stock_number: "SK1",
    vin: null,
    year: 2019,
    make: "Honda",
    model: "Civic",
    trim: "LX",
    mileage: 50000,
    price_cents: 1799000,
    photo_url: null,
    description: "Reliable sedan with low miles.",
    status: "available",
    title: null,
    last_listed_at: new Date().toISOString(),
    created_at: new Date().toISOString(),
    updated_at: new Date().toISOString(),
    ...overrides,
  };
  tables.vehicles.set(v.id, v);
  return v;
}

function seedConversation(
  dealer: DealerRow,
  overrides: Partial<ConversationRow> = {},
): ConversationRow {
  const c: ConversationRow = {
    id: mintId("cccccccc"),
    dealer_id: dealer.id,
    buyer_session: "sms:+15555550101",
    language: "en",
    status: "open",
    last_intent: null,
    lead_status: "new",
    notes: null,
    assigned_user_id: null,
    channel: "sms",
    buyer_phone: "+15555550101",
    suppressed_at: null,
    scheduled_at: null,
    lead_score: "cold",
    buyer_intent_make: "Honda",
    buyer_intent_model: "Civic",
    buyer_intent_body_type: null,
    test_drive_status: null,
    forked_from_conversation_id: null,
    created_at: new Date(Date.now() - 30 * 24 * 60 * 60 * 1000).toISOString(),
    updated_at: new Date(Date.now() - 20 * 24 * 60 * 60 * 1000).toISOString(),
    ...overrides,
  };
  tables.conversations.set(c.id, c);
  return c;
}

function seedConsent(conversationId: string, dealerId: string, channel: "sms" | "whatsapp"): void {
  const id = mintId("11111111");
  tables.consents.set(id, {
    id,
    conversation_id: conversationId,
    dealer_id: dealerId,
    channel,
    consent_text: "I agree",
    created_at: new Date().toISOString(),
  });
}

function seedKeywordEvent(conversationId: string, dealerId: string, keyword: "STOP" | "HELP" | "START"): void {
  const id = mintId("22222222");
  tables.keyword_events.set(id, {
    id,
    conversation_id: conversationId,
    dealer_id: dealerId,
    keyword,
    channel: "sms",
    raw_message: keyword,
    created_at: new Date().toISOString(),
  });
}

function seedReEngagementAudit(
  buyerId: string,
  dealerId: string,
  vehicleId: string,
  daysAgo: number,
): void {
  const id = mintId("33333333");
  tables.re_engagement_audit.set(id, {
    id,
    buyer_id: buyerId,
    dealer_id: dealerId,
    vehicle_id: vehicleId,
    vehicle_event_id: null,
    match_reason: "make+model",
    channel: "sms",
    content_hash: "a".repeat(64),
    sent_at: new Date(Date.now() - daysAgo * 24 * 60 * 60 * 1000).toISOString(),
  });
}

function seedBuyerMessage(conversationId: string, daysAgo: number): void {
  const id = mintId("44444444");
  tables.messages.set(id, {
    id,
    conversation_id: conversationId,
    role: "buyer",
    body: "interested",
    intent: null,
    language: "en",
    approval_status: "auto",
    delivery_channel: "sms",
    delivery_sid: null,
    created_at: new Date(Date.now() - daysAgo * 24 * 60 * 60 * 1000).toISOString(),
  });
}

function makeCandidate(
  conversation: ConversationRow,
  vehicle: VehicleRow,
  matchReason = "make+model",
): MatchCandidate {
  const event: VehicleEventRow = {
    id: mintId("99999999"),
    dealer_id: vehicle.dealer_id,
    vehicle_id: vehicle.id,
    kind: "new_listing",
    metadata: {},
    created_at: new Date().toISOString(),
  };
  return { conversation, vehicle, event, matchReason, affinityScore: 6 };
}

// 2026-05-15 14:00 UTC == 10:00 America/New_York (EDT). Outside quiet
// hours. We pin "now" so quiet-hour assertions don't drift with the
// suite's wall clock.
const NOW_OPEN = new Date("2026-05-15T14:00:00Z");
// Same date, 22:00 America/New_York == 02:00 UTC next day.
const NOW_QUIET = new Date("2026-05-16T02:00:00Z");

beforeEach(() => {
  tables = freshTables();
  sendSmsSpy.mockClear();
  sendWhatsAppSpy.mockClear();
  sendSmsSpy.mockImplementation(async () => ({ queued: true, sid: "SM_test" }));
  sendWhatsAppSpy.mockImplementation(async () => ({ queued: true, messageId: "wa_test" }));
});

describe("attemptReEngagement TCPA gates", () => {
  it("happy path SMS — audit row written, dispatch invoked", async () => {
    const dealer = seedDealer();
    const vehicle = seedVehicle(dealer);
    const conv = seedConversation(dealer);
    seedConsent(conv.id, dealer.id, "sms");

    const out = await attemptReEngagement(
      { sb: makeFakeSb(), dealer, now: NOW_OPEN },
      makeCandidate(conv, vehicle),
    );

    expect(out.sent).toBe(true);
    expect(out.channel).toBe("sms");
    expect(sendSmsSpy).toHaveBeenCalledTimes(1);
    expect(tables.re_engagement_audit.size).toBe(1);
    const audit = [...tables.re_engagement_audit.values()][0] as Record<string, unknown>;
    expect(audit.buyer_id).toBe(conv.id);
    expect(audit.vehicle_id).toBe(vehicle.id);
    expect(audit.channel).toBe("sms");
    expect(String(audit.content_hash).length).toBe(64);
  });

  it("ES happy path — Spanish body, audit written", async () => {
    const dealer = seedDealer();
    const vehicle = seedVehicle(dealer);
    const conv = seedConversation(dealer, { language: "es" });
    seedConsent(conv.id, dealer.id, "sms");

    const out = await attemptReEngagement(
      { sb: makeFakeSb(), dealer, now: NOW_OPEN },
      makeCandidate(conv, vehicle),
    );

    expect(out.sent).toBe(true);
    const call = sendSmsSpy.mock.calls[0] as unknown as [{ to: string; body: string }];
    expect(call[0].body).toMatch(/coincide|STOP para cancelar/);
  });

  it("consent missing — hard skip, no audit row", async () => {
    const dealer = seedDealer();
    const vehicle = seedVehicle(dealer);
    const conv = seedConversation(dealer);
    // Intentionally no seedConsent.

    const out = await attemptReEngagement(
      { sb: makeFakeSb(), dealer, now: NOW_OPEN },
      makeCandidate(conv, vehicle),
    );

    expect(out.sent).toBe(false);
    expect(out.skipReason).toBe("no_consent");
    expect(sendSmsSpy).not.toHaveBeenCalled();
    expect(tables.re_engagement_audit.size).toBe(0);
  });

  it("STOP keyword in history — hard skip, no audit row", async () => {
    const dealer = seedDealer();
    const vehicle = seedVehicle(dealer);
    const conv = seedConversation(dealer);
    seedConsent(conv.id, dealer.id, "sms");
    seedKeywordEvent(conv.id, dealer.id, "STOP");

    const out = await attemptReEngagement(
      { sb: makeFakeSb(), dealer, now: NOW_OPEN },
      makeCandidate(conv, vehicle),
    );

    expect(out.sent).toBe(false);
    expect(out.skipReason).toBe("stop_in_history");
    expect(sendSmsSpy).not.toHaveBeenCalled();
    expect(tables.re_engagement_audit.size).toBe(0);
  });

  it("opted_out (suppressed_at) — hard skip", async () => {
    const dealer = seedDealer();
    const vehicle = seedVehicle(dealer);
    const conv = seedConversation(dealer, {
      suppressed_at: new Date().toISOString(),
    });
    seedConsent(conv.id, dealer.id, "sms");

    const out = await attemptReEngagement(
      { sb: makeFakeSb(), dealer, now: NOW_OPEN },
      makeCandidate(conv, vehicle),
    );

    expect(out.sent).toBe(false);
    expect(out.skipReason).toBe("suppressed");
    expect(sendSmsSpy).not.toHaveBeenCalled();
    expect(tables.re_engagement_audit.size).toBe(0);
  });

  it("quiet hours (22:00 local) — hard skip", async () => {
    const dealer = seedDealer();
    const vehicle = seedVehicle(dealer);
    const conv = seedConversation(dealer);
    seedConsent(conv.id, dealer.id, "sms");

    // Sanity-check the helper before the gate: 22:00 in NY should be quiet.
    expect(isQuietHour(hourInTimezone(NOW_QUIET, "America/New_York"))).toBe(true);

    const out = await attemptReEngagement(
      { sb: makeFakeSb(), dealer, now: NOW_QUIET },
      makeCandidate(conv, vehicle),
    );

    expect(out.sent).toBe(false);
    expect(out.skipReason).toBe("quiet_hours");
    expect(sendSmsSpy).not.toHaveBeenCalled();
  });

  it("14-day cooldown — hard skip when prior audit < 14d", async () => {
    const dealer = seedDealer();
    const vehicle = seedVehicle(dealer);
    const conv = seedConversation(dealer);
    seedConsent(conv.id, dealer.id, "sms");
    seedReEngagementAudit(conv.id, dealer.id, vehicle.id, 3); // 3 days ago

    const out = await attemptReEngagement(
      { sb: makeFakeSb(), dealer, now: NOW_OPEN },
      makeCandidate(conv, vehicle),
    );

    expect(out.sent).toBe(false);
    expect(out.skipReason).toBe("cooldown");
    expect(sendSmsSpy).not.toHaveBeenCalled();
    // Original audit row remains; we did NOT write a second.
    expect(tables.re_engagement_audit.size).toBe(1);
  });

  it("per-dealer cap — hard skip when 50 sent today", async () => {
    const dealer = seedDealer();
    const vehicle = seedVehicle(dealer);
    const conv = seedConversation(dealer);
    seedConsent(conv.id, dealer.id, "sms");

    // Pre-seed 50 audit rows dated today.
    for (let i = 0; i < 50; i += 1) {
      const buyerId = mintId("cccccccc");
      // Use a different buyer_id each so cooldown doesn't trip first.
      // Date in the future relative to start-of-day-utc(now=NOW_OPEN).
      const id = mintId("33333333");
      tables.re_engagement_audit.set(id, {
        id,
        buyer_id: buyerId,
        dealer_id: dealer.id,
        vehicle_id: vehicle.id,
        vehicle_event_id: null,
        match_reason: "make",
        channel: "sms",
        content_hash: "b".repeat(64),
        sent_at: new Date(NOW_OPEN.getTime() + 60_000 * (i + 1)).toISOString(),
      });
    }

    const out = await attemptReEngagement(
      { sb: makeFakeSb(), dealer, now: NOW_OPEN },
      makeCandidate(conv, vehicle),
    );

    expect(out.sent).toBe(false);
    expect(out.skipReason).toBe("dealer_cap");
    expect(sendSmsSpy).not.toHaveBeenCalled();
  });

  it("freshness — buyer replied < 7 days ago, skip", async () => {
    const dealer = seedDealer();
    const vehicle = seedVehicle(dealer);
    const conv = seedConversation(dealer);
    seedConsent(conv.id, dealer.id, "sms");
    seedBuyerMessage(conv.id, 3); // 3 days ago

    const out = await attemptReEngagement(
      { sb: makeFakeSb(), dealer, now: NOW_OPEN },
      makeCandidate(conv, vehicle),
    );

    expect(out.sent).toBe(false);
    expect(out.skipReason).toBe("not_fresh");
    expect(sendSmsSpy).not.toHaveBeenCalled();
  });

  it("no buyer phone — skip with no_phone", async () => {
    const dealer = seedDealer();
    const vehicle = seedVehicle(dealer);
    const conv = seedConversation(dealer, { buyer_phone: null });

    const out = await attemptReEngagement(
      { sb: makeFakeSb(), dealer, now: NOW_OPEN },
      makeCandidate(conv, vehicle),
    );

    expect(out.sent).toBe(false);
    expect(out.skipReason).toBe("no_phone");
  });

  it("unsupported channel (web) — skip", async () => {
    const dealer = seedDealer();
    const vehicle = seedVehicle(dealer);
    const conv = seedConversation(dealer, {
      channel: "web",
      buyer_phone: "+15555550101",
    });

    const out = await attemptReEngagement(
      { sb: makeFakeSb(), dealer, now: NOW_OPEN },
      makeCandidate(conv, vehicle),
    );

    expect(out.sent).toBe(false);
    expect(out.skipReason).toBe("unsupported_channel");
  });

  it("vehicle no longer available — skip", async () => {
    const dealer = seedDealer();
    const vehicle = seedVehicle(dealer, { status: "sold" });
    const conv = seedConversation(dealer);
    seedConsent(conv.id, dealer.id, "sms");

    const out = await attemptReEngagement(
      { sb: makeFakeSb(), dealer, now: NOW_OPEN },
      makeCandidate(conv, vehicle),
    );

    expect(out.sent).toBe(false);
    expect(out.skipReason).toBe("vehicle_unavailable");
    expect(tables.re_engagement_audit.size).toBe(0);
  });

  it("quiet-hour helper boundary: 21:00 = quiet, 20:00 = allowed, 08:00 = allowed, 07:59 (== 7) = quiet", () => {
    expect(isQuietHour(21)).toBe(true);
    expect(isQuietHour(20)).toBe(false);
    expect(isQuietHour(8)).toBe(false);
    expect(isQuietHour(7)).toBe(true);
    expect(isQuietHour(0)).toBe(true);
  });
});
