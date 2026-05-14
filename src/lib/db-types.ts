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
  onboarded_at: string | null;
  created_at: string;
  updated_at: string;
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
  created_at: string;
  updated_at: string;
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
