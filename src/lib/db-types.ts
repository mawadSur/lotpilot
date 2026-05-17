// Hand-written database row types for the LotPilot v0.1+v0.2 schema. We
// could generate these with `supabase gen types typescript` later; for
// now this keeps us TypeScript-strict end-to-end without an extra build
// step.

export type Lang = "en" | "es";
export type ConversationStatus = "open" | "closed";
export type Intent =
  | "test_drive"
  | "financing"
  | "trade_in"
  | "general"
  | "ready_to_close";
export type MessageRole = "buyer" | "ai" | "dealer";
export type VehicleStatus = "available" | "pending" | "sold" | "hidden";

// v0.2 additions
export type ApprovalStatus = "auto" | "pending" | "approved" | "rejected" | "sent";
export type LeadStatus = "new" | "qualified" | "booked" | "sold" | "lost";
// v0.3 widened the union with 'relay' (paste/copy Marketplace flow,
// driven by the dealer from /dashboard/relay) and 'voice' (Vapi).
// v0.5 adds 'marketplace' (browser-extension ingest) and 'whatsapp'
// (Meta Cloud API). conversation-router.ts is already channel-agnostic
// — no router change needed.
export type ChatChannel =
  | "web"
  | "sms"
  | "relay"
  | "voice"
  | "marketplace"
  | "whatsapp";
export type KeywordHit = "STOP" | "HELP" | "START";

export interface BusinessHoursMap {
  // [open, close] in 24-hour HH:MM, or null for closed.
  mon: [string, string] | null;
  tue: [string, string] | null;
  wed: [string, string] | null;
  thu: [string, string] | null;
  fri: [string, string] | null;
  sat: [string, string] | null;
  sun: [string, string] | null;
}

export interface DealerRow {
  id: string;
  owner_user_id: string;
  slug: string;
  name: string;
  signature: string | null;
  business_hours: BusinessHoursMap;
  calendly_url: string | null;
  timezone: string;
  // v0.2: dealer-side approval queue + outbound SMS number (E.164).
  approve_before_send: boolean;
  sms_number: string | null;
  // v0.3: inbound voice number provisioned in Vapi.
  voice_number: string | null;
  // v0.5: cached Calendly event_type URI (set by the webhook the first
  // time the Calendly API resolves this dealer; thereafter the webhook
  // matches by exact equality and never hits the Calendly API again).
  calendly_event_type_uri: string | null;
  // v0.5: E.164 inbound number registered with the WhatsApp Business
  // / Meta Cloud API. Same shape as sms_number / voice_number.
  whatsapp_number: string | null;
  // v0.6: 5-digit US ZIP captured at onboarding; zip3 is the 3-digit
  // prefix derived by trigger (used as the privacy-floored aggregation
  // key in dealer_zip_benchmarks).
  zip: string | null;
  zip3: string | null;
  // v0.7 T1.7: per-dealer kill switch for auto-confirm reminders.
  // Defaults to true server-side (migration 0013) so existing dealers
  // opt in by default. The drainer skips queued rows when this is
  // false and marks them completed with last_error='auto_confirm_disabled'.
  auto_confirm_enabled: boolean;
  onboarded_at: string | null;
  created_at: string;
  updated_at: string;
}

// v0.7 T1.7: scheduled outbound reminders, enqueued by the calendly
// webhook on booking and drained by /api/internal/drain-reminders.
// Mirrors pending_compliance_audits shape so a single cron pattern
// handles both queues.
export type ScheduledReminderKind = "confirm_24h" | "confirm_2h";
export type NoShowTier = "low" | "medium" | "high";

export interface ScheduledReminderRow {
  id: string;
  dealer_id: string;
  conversation_id: string;
  kind: ScheduledReminderKind;
  risk_score: number;
  risk_tier: NoShowTier;
  body_en: string;
  body_es: string;
  send_at: string;
  attempts: number;
  last_attempted_at: string | null;
  completed_at: string | null;
  last_error: string | null;
  payload: Record<string, unknown>;
  created_at: string;
}

// v0.6: operator-visible warnings written by the service role on
// Calendly no-match, WhatsApp auth/window failures, and marketplace
// secret disclosures. Surfaced as a dismissible banner.
export type SystemWarningKind =
  | "calendly_no_match"
  | "calendly_api_ambiguous"
  | "whatsapp_auth_failed"
  | "whatsapp_window_closed"
  | "marketplace_secret_disclosed"
  // v0.7: written by /api/marketplace/inbound when an HMAC verifies
  // against MARKETPLACE_MASTER_SECRET_PREV. Tells the dealer their
  // extension is signing under the old master and should be re-issued.
  | "marketplace_secret_rotated";

export interface SystemWarningRow {
  id: string;
  dealer_id: string;
  kind: SystemWarningKind;
  payload: Record<string, unknown>;
  created_at: string;
  resolved_at: string | null;
}

// v0.6: compliance export audit row. One per CSV download.
export type ComplianceExportScope =
  | "conversation_ids"
  | "date_range"
  | "dealer_wide";

export interface ComplianceExportRow {
  id: string;
  dealer_id: string;
  exported_by: string;
  scope: ComplianceExportScope;
  scope_payload: Record<string, unknown>;
  row_count: number;
  created_at: string;
}

// v0.7: durable outbox for the compliance export audit trail. The
// export route inserts a row here BEFORE streaming bytes; a background
// cron drains the queue into compliance_exports. Closes the v0.6 gap
// where a transient post-stream insert failure could let CSV bytes
// leave without an audit row.
export interface PendingComplianceAuditRow {
  id: string;
  dealer_id: string;
  exported_by: string;
  scope: ComplianceExportScope;
  scope_payload: Record<string, unknown>;
  row_count: number;
  attempts: number;
  last_attempted_at: string | null;
  completed_at: string | null;
  last_error: string | null;
  created_at: string;
}

// v0.6: aggregated benchmark stats per dealer + zip3. The view enforces
// dealer_count >= 3 in SQL HAVING — no row is ever returned for a
// zip3 with fewer than 3 dealers.
export interface DealerZipBenchmarkRow {
  dealer_id: string;
  zip3: string;
  median_response_sec: number | null;
  conversion_rate: number | null;
  zip_median_response_sec: number | null;
  zip_median_conversion: number | null;
  dealer_count: number;
}

export interface VehicleRow {
  id: string;
  dealer_id: string;
  stock_number: string;
  vin: string | null;
  year: number | null;
  make: string | null;
  model: string | null;
  trim: string | null;
  mileage: number | null;
  price_cents: number | null;
  photo_url: string | null;
  description: string | null;
  status: VehicleStatus;
  // v0.4: dealer-curated marketplace title (overrides year/make/model
  // fallback in the inventory UI; written by the optimizer auto-sync).
  title: string | null;
  // v0.4: drives the auto-repost tile. Defaults to now() server-side,
  // so the column is non-null on every row.
  last_listed_at: string;
  created_at: string;
  updated_at: string;
}

export type LeadScore = "hot" | "warm" | "cold";

export interface ConversationRow {
  id: string;
  dealer_id: string;
  buyer_session: string;
  language: Lang;
  status: ConversationStatus;
  last_intent: Intent | null;
  // v0.2 additions
  lead_status: LeadStatus;
  notes: string | null;
  assigned_user_id: string | null;
  channel: ChatChannel;
  buyer_phone: string | null;
  suppressed_at: string | null;
  // v0.3: when the buyer's test drive is on the books. Set by the
  // chat pipeline on a successful test_drive + offered_calendly turn.
  scheduled_at: string | null;
  // v0.6: heuristic temperature ('hot'|'warm'|'cold'). Recomputed by
  // chat-pipeline.ts on every AI reply turn. Null on conversations
  // that haven't turned since v0.5 (no migration backfill).
  lead_score: LeadScore | null;
  // T2.5: lightweight buyer-intent capture used by the re-engagement
  // matcher (src/lib/re-engagement/match.ts). Substring-affinity match
  // against vehicle make/model/body_type. Nullable — most cold leads
  // will have at most 1-2 of these populated.
  buyer_intent_make: string | null;
  buyer_intent_model: string | null;
  buyer_intent_body_type: string | null;
  // v0.7 / T1.9: lifecycle of the booked test drive. null = scheduled
  // but not driven yet. 'completed' = Calendly event_ended fired OR the
  // cron sweep noticed scheduled_at < now (the trigger for the
  // 24h/72h/7d follow-up cadence). 'no_show' is reserved for T1.7.
  test_drive_status: "completed" | "no_show" | null;
  // v0.7.3 / T4.2: when this conversation was forked from another
  // (lead-share accepted), the source conversation id. NULL on every
  // non-fork conversation (the typical case).
  forked_from_conversation_id: string | null;
  created_at: string;
  updated_at: string;
}

// v0.7 / T1.9: post-test-drive follow-up queue row. One per planned
// send (steps 1/2/3 == +24h/+72h/+168h). Mutated only by the
// service-role scheduler + cron drainer; authenticated dealers can
// READ their own rows via RLS for a future dashboard tile but can
// never INSERT/UPDATE/DELETE.
export type FollowUpStep = 1 | 2 | 3;
export type FollowUpCancelReason =
  | "buyer_replied"
  | "lead_sold"
  | "lead_lost"
  | "opted_out"
  | "no_consent";

export interface FollowUpJobRow {
  id: string;
  dealer_id: string;
  conversation_id: string;
  step: FollowUpStep;
  send_at: string;
  sent_at: string | null;
  cancelled_at: string | null;
  cancel_reason: FollowUpCancelReason | null;
  attempts: number;
  last_attempted_at: string | null;
  last_error: string | null;
  created_at: string;
}

export interface MessageRow {
  id: string;
  conversation_id: string;
  role: MessageRole;
  body: string;
  intent: Intent | null;
  language: Lang | null;
  // v0.2: defaults to 'auto'; 'pending' for AI drafts in approve-before-
  // send mode; 'approved' / 'rejected' / 'sent' as the dealer acts on them.
  approval_status: ApprovalStatus;
  approved_by: string | null;
  approved_at: string | null;
  original_body: string | null;
  delivery_channel: ChatChannel | null;
  delivery_sid: string | null;
  created_at: string;
}

export interface ConsentRow {
  id: string;
  dealer_id: string;
  conversation_id: string;
  channel: ChatChannel;
  consent_text: string;
  ip_address: string | null;
  user_agent: string | null;
  buyer_phone: string | null;
  created_at: string;
}

export interface KeywordEventRow {
  id: string;
  dealer_id: string;
  conversation_id: string;
  keyword: KeywordHit;
  channel: ChatChannel;
  raw_message: string;
  created_at: string;
}

// View used by the inbox to avoid N+1: one row per conversation with
// the latest message body, role, created_at folded in plus a
// pending-count for the approve-before-send queue. v0.4 adds
// `last_dealer_reply_at` so the reminder tile can drop bookings the
// dealer already followed up on, in a single SQL filter.
export interface ConversationWithLatestRow extends ConversationRow {
  last_message_body: string | null;
  last_message_role: MessageRole | null;
  last_message_at: string | null;
  pending_count: number;
  last_dealer_reply_at: string | null;
}

// v0.7.3 / T3.2: per (dealer, make, model) demand-vs-supply row from
// migration 0016's acquisition_signal_30d view. score is a numeric
// from postgres → comes back as string over the wire; rank.ts coerces
// to number before sorting + returning. demand_count / inventory_count
// are integers from `count(*)`.
export interface AcquisitionSignalRow {
  dealer_id: string;
  make: string | null;
  model: string | null;
  demand_count: number;
  hot_count: number;
  warm_count: number;
  cold_count: number;
  inventory_count: number;
  score: string | number;
}

// v0.7.3 / T4.2 — Lead-share lifecycle row. State transitions are
// service-role only (no INSERT/UPDATE/DELETE policy for authenticated
// — enforced by migration 0017's RAISE EXCEPTION on writer_policies).
export type LeadShareStatus =
  | "pending"
  | "consent_sent"
  | "accepted"
  | "declined"
  | "expired"
  | "cancelled";

export type LeadShareCancelReason =
  | "no_consent"
  | "no_buyer_phone"
  | "suppressed"
  | "channel_unsupported"
  | "sms_send_failed"
  | "manual"
  | string;

export interface LeadShareRow {
  id: string;
  source_dealer_id: string;
  target_dealer_id: string;
  source_conversation_id: string;
  forked_conversation_id: string | null;
  status: LeadShareStatus;
  revenue_split_pct: string | number;
  consent_message_id: string | null;
  consent_sent_at: string | null;
  accepted_at: string | null;
  declined_at: string | null;
  expired_at: string | null;
  cancelled_at: string | null;
  cancel_reason: string | null;
  notes: string | null;
  created_by_user_id: string;
  created_at: string;
}

// v0.3: cached AI-generated Marketplace listing variants per vehicle.
// The /optimize endpoint always writes 3 in a single batch; the dealer
// picks one (PATCH sets accepted_at), but the others are kept for
// re-roll / A-B inspection. v0.4 adds previous_title /
// previous_description, captured at sync time before the optimizer
// stomps the live vehicle row — so a regretful dealer can recover.
export interface ListingSuggestionRow {
  id: string;
  vehicle_id: string;
  dealer_id: string;
  title: string;
  description: string;
  photo_order_hint: string[] | null;
  rationale: string | null;
  accepted_at: string | null;
  previous_title: string | null;
  previous_description: string | null;
  created_at: string;
}

// v0.7: founder-voice Spanish phrasing examples. Dealers may add their
// own (dealer_id = their id); globals (dealer_id null) are seeded by
// the founder via service-role only. RLS lets each dealer read its own
// rows PLUS globals; archived_at is set in lieu of a hard delete so
// the corpus stays auditable. See migration 0009_v07_audit_queue_spanish_corpus.sql.
export type SpanishPhraseIntent =
  | "test_drive"
  | "financing"
  | "trade_in"
  | "general"
  | "ready_to_close";

export interface SpanishPhraseRow {
  id: string;
  // Nullable: null == global (founder-seeded) row.
  dealer_id: string | null;
  intent: SpanishPhraseIntent;
  // Optional short tag (e.g. "first-greeting"); max 60 chars per migration.
  situation_tag: string | null;
  en_text: string;
  es_text: string;
  created_by: string | null;
  created_at: string;
  // Soft-delete marker; rows with archived_at != null are excluded from
  // the corpus injected into the system prompt.
  archived_at: string | null;
}

// T2.5: vehicle event drives the re-engagement sweep cron. The CSV /
// DMS / optimizer producers insert rows; the cron walks the last 24h
// and emits candidate sends per event. Service-role writes only — the
// re_engagement worker reads via service-role too (no dealer ctx).
export type VehicleEventKind = "new_listing" | "price_drop";

export interface VehicleEventRow {
  id: string;
  dealer_id: string;
  vehicle_id: string;
  kind: VehicleEventKind;
  metadata: Record<string, unknown>;
  created_at: string;
}

// T2.5: append-only audit log of every re-engagement outbound. The
// TCPA contract is: 1 send → 1 row, written BEFORE the dispatch call
// so a transient outbound failure still leaves the attempt logged
// (regulators prefer "tried and 5xx'd" to "no record"). content_hash
// is sha256 of the dispatched body — full body lives on the messages
// row (joined by buyer_id == conversation_id).
export type ReEngagementChannel = "sms" | "whatsapp";

export interface ReEngagementAuditRow {
  id: string;
  dealer_id: string;
  buyer_id: string; // == conversations.id
  vehicle_id: string;
  vehicle_event_id: string | null;
  match_reason: string;
  channel: ReEngagementChannel;
  content_hash: string;
  sent_at: string;
}

// Marketing-side waitlist table — owned by the 0001_init.sql migration.
// Anonymous role can INSERT only; reads are service-role only.
export interface DealerSignupRow {
  id: string;
  dealership_name: string;
  contact_name: string;
  email: string;
  phone: string | null;
  inventory_size: number | null;
  primary_channel: string | null;
  notes: string | null;
  user_agent: string | null;
  created_at: string;
}

export interface Database {
  public: {
    Tables: {
      dealer_signups: {
        Row: DealerSignupRow;
        Insert: Omit<DealerSignupRow, "id" | "created_at"> & {
          id?: string;
          created_at?: string;
        };
        Update: Partial<Omit<DealerSignupRow, "id" | "created_at">>;
        Relationships: [];
      };
      dealers: {
        Row: DealerRow;
        Insert: Omit<DealerRow, "id" | "created_at" | "updated_at"> & {
          id?: string;
          created_at?: string;
          updated_at?: string;
        };
        Update: Partial<Omit<DealerRow, "id" | "owner_user_id" | "created_at">>;
        Relationships: [];
      };
      vehicles: {
        Row: VehicleRow;
        Insert: Omit<VehicleRow, "id" | "created_at" | "updated_at"> & {
          id?: string;
          created_at?: string;
          updated_at?: string;
        };
        Update: Partial<Omit<VehicleRow, "id" | "dealer_id" | "created_at">>;
        Relationships: [];
      };
      conversations: {
        Row: ConversationRow;
        Insert: Omit<ConversationRow, "id" | "created_at" | "updated_at"> & {
          id?: string;
          created_at?: string;
          updated_at?: string;
        };
        Update: Partial<Omit<ConversationRow, "id" | "dealer_id" | "buyer_session" | "created_at">>;
        Relationships: [];
      };
      messages: {
        Row: MessageRow;
        Insert: Omit<MessageRow, "id" | "created_at"> & {
          id?: string;
          created_at?: string;
        };
        Update: Partial<Omit<MessageRow, "id" | "conversation_id" | "created_at">>;
        Relationships: [];
      };
      consents: {
        Row: ConsentRow;
        Insert: Omit<ConsentRow, "id" | "created_at"> & {
          id?: string;
          created_at?: string;
        };
        Update: Partial<Omit<ConsentRow, "id" | "conversation_id" | "created_at">>;
        Relationships: [];
      };
      keyword_events: {
        Row: KeywordEventRow;
        Insert: Omit<KeywordEventRow, "id" | "created_at"> & {
          id?: string;
          created_at?: string;
        };
        Update: Partial<Omit<KeywordEventRow, "id" | "conversation_id" | "created_at">>;
        Relationships: [];
      };
      listing_suggestions: {
        Row: ListingSuggestionRow;
        Insert: Omit<ListingSuggestionRow, "id" | "created_at"> & {
          id?: string;
          created_at?: string;
        };
        Update: Partial<Omit<ListingSuggestionRow, "id" | "vehicle_id" | "dealer_id" | "created_at">>;
        Relationships: [];
      };
      spanish_phrases: {
        Row: SpanishPhraseRow;
        Insert: Omit<SpanishPhraseRow, "id" | "created_at"> & {
          id?: string;
          created_at?: string;
        };
        Update: Partial<Omit<SpanishPhraseRow, "id" | "created_at">>;
        Relationships: [];
      };
    };
    Views: {
      conversations_with_latest: {
        Row: ConversationWithLatestRow;
        Relationships: [];
      };
    };
    Functions: Record<string, never>;
    Enums: Record<string, never>;
    CompositeTypes: Record<string, never>;
  };
}
