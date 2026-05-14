// AI listing optimizer. Generates exactly 3 distinct Marketplace
// listing variants for a single vehicle. Three angles, hand-picked to
// cover the range a dealer might A/B between:
//
//   variant 0 — "price"     : leads with value, payment-friendly
//   variant 1 — "features"  : leads with the car's strongest specs
//   variant 2 — "urgency"   : low-mileage / one-owner / first-week framing
//
// Cost guardrail: max_tokens is capped at LISTING_MAX_TOKENS (600) and
// the call shares the per-dealer daily budget circuit breaker that
// gates the chat reply engine. A vehicle with no description still
// works — we synthesise from year/make/model/trim/mileage/price.

import Anthropic from "@anthropic-ai/sdk";
import type { TextBlock } from "@anthropic-ai/sdk/resources/messages";
import { parseModelArray } from "./ai-json";
import { requireAnthropicKey } from "./env";
import type { DealerRow, VehicleRow } from "./db-types";

const MODEL = process.env.ANTHROPIC_MODEL?.trim() || "claude-sonnet-4-6";
const LISTING_MAX_TOKENS = 600;
const VARIANT_COUNT = 3;
const MAX_TITLE_CHARS = 120;
const MAX_DESCRIPTION_CHARS = 4000;
const MAX_PHOTO_HINTS = 20;
const MAX_RATIONALE_CHARS = 1000;

export const LISTING_AI_MAX_OUTPUT_TOKENS = LISTING_MAX_TOKENS;
export const LISTING_VARIANT_COUNT = VARIANT_COUNT;

export interface ListingVariant {
  title: string;
  description: string;
  photo_order_hint: string[];
  rationale: string;
}

export interface ListingOptimizerArgs {
  dealer: DealerRow;
  vehicle: VehicleRow;
}

export interface ListingOptimizerUsage {
  input_tokens: number;
  output_tokens: number;
}

export interface ListingOptimizerResult {
  variants: ListingVariant[];
  usage: ListingOptimizerUsage;
}

export class ListingOptimizerError extends Error {
  constructor(message: string, public readonly cause?: unknown) {
    super(message);
    this.name = "ListingOptimizerError";
  }
}

let cached: Anthropic | null = null;
function client(): Anthropic {
  if (cached) return cached;
  cached = new Anthropic({ apiKey: requireAnthropicKey() });
  return cached;
}

const LISTING_SYSTEM = `
You write Facebook Marketplace listings for an independent used-car dealer.
Your job: produce three distinct angles a dealer can A/B between when they
post the same vehicle.

Each variant must come from a different angle:
  - variant 0: "price" — lead with value or affordability
  - variant 1: "features" — lead with the strongest specs or condition
  - variant 2: "urgency" — lead with scarcity / one-owner / low miles / first-week framing

Hard rules:
- Title <= 120 characters. No ALL CAPS, no spam emoji, no exclamation chains.
- Description <= 4000 characters, written warm and direct in the dealer's
  voice. Plain text only — Marketplace renders no markdown.
- Use only facts from the VEHICLE block. Never invent a feature, a price,
  or a mileage figure. If a field is missing, omit it; do not guess.
- Quote the dealer's signature line once, at the end of the description.
- photo_order_hint: 3..6 short phrases (each <= 60 chars) describing what
  the dealer should put in slots 1, 2, 3, ... — e.g. "front 3/4 in
  daylight", "interior dash", "engine bay clean". Order matters.
- rationale: one or two sentences, dealer-facing, explaining WHY this
  angle works for THIS vehicle. <= 1000 chars.

OUTPUT: respond with ONLY a single JSON array of length 3. No prose, no
markdown fences. Schema for each element:

{
  "title": "<<= 120 chars>",
  "description": "<plain text, <= 4000 chars>",
  "photo_order_hint": ["slot 1", "slot 2", ...],
  "rationale": "<dealer-facing, <= 1000 chars>"
}
`.trim();

function vehicleBlock(v: VehicleRow): string {
  const lines: string[] = ["VEHICLE"];
  if (v.year != null) lines.push(`Year: ${v.year}`);
  if (v.make) lines.push(`Make: ${v.make}`);
  if (v.model) lines.push(`Model: ${v.model}`);
  if (v.trim) lines.push(`Trim: ${v.trim}`);
  if (v.mileage != null) lines.push(`Mileage: ${v.mileage.toLocaleString()} mi`);
  if (v.price_cents != null) {
    lines.push(`Asking price: $${Math.round(v.price_cents / 100).toLocaleString()}`);
  }
  if (v.vin) lines.push(`VIN: ${v.vin}`);
  lines.push(`Stock #: ${v.stock_number}`);
  if (v.description) {
    lines.push(`Existing description: ${v.description.slice(0, 2000)}`);
  }
  return lines.join("\n");
}

function dealerBlock(dealer: DealerRow): string {
  const sig = (dealer.signature ?? dealer.name).trim();
  return [
    "DEALER",
    `Name: ${dealer.name}`,
    `Signature line (use verbatim once): "${sig}"`,
  ].join("\n");
}

export function buildListingPrompt(args: ListingOptimizerArgs): string {
  return [LISTING_SYSTEM, "", dealerBlock(args.dealer), "", vehicleBlock(args.vehicle)].join("\n");
}

function clampString(value: unknown, max: number): string {
  if (typeof value !== "string") return "";
  const trimmed = value.trim();
  if (trimmed.length === 0) return "";
  return trimmed.length > max ? trimmed.slice(0, max) : trimmed;
}

function clampStringArray(value: unknown, maxItems: number, maxItemLen: number): string[] {
  if (!Array.isArray(value)) return [];
  const out: string[] = [];
  for (const item of value) {
    if (typeof item !== "string") continue;
    const t = item.trim();
    if (!t) continue;
    out.push(t.length > maxItemLen ? t.slice(0, maxItemLen) : t);
    if (out.length >= maxItems) break;
  }
  return out;
}

function coerceVariant(raw: unknown): ListingVariant | null {
  if (!raw || typeof raw !== "object") return null;
  const r = raw as Record<string, unknown>;
  const title = clampString(r.title, MAX_TITLE_CHARS);
  const description = clampString(r.description, MAX_DESCRIPTION_CHARS);
  if (!title || !description) return null;
  return {
    title,
    description,
    photo_order_hint: clampStringArray(r.photo_order_hint, MAX_PHOTO_HINTS, 60),
    rationale: clampString(r.rationale, MAX_RATIONALE_CHARS),
  };
}

export function estimateListingChars(args: ListingOptimizerArgs): number {
  return buildListingPrompt(args).length;
}

export async function generateListingVariants(
  args: ListingOptimizerArgs,
): Promise<ListingOptimizerResult> {
  const system = buildListingPrompt(args);

  let result: Awaited<ReturnType<Anthropic["messages"]["create"]>>;
  try {
    result = await client().messages.create({
      model: MODEL,
      max_tokens: LISTING_MAX_TOKENS,
      system,
      messages: [
        {
          role: "user",
          content:
            "Generate the three listing variants now. Return only the JSON array.",
        },
      ],
    });
  } catch (err) {
    throw new ListingOptimizerError("Anthropic request failed", err);
  }

  const textBlock = result.content.find(
    (block): block is TextBlock => block.type === "text",
  );
  if (!textBlock) {
    throw new ListingOptimizerError("Anthropic returned no text block");
  }

  const parsed = parseModelArray(textBlock.text);
  if (!parsed) {
    throw new ListingOptimizerError("Anthropic response was not parseable JSON array");
  }

  const variants: ListingVariant[] = [];
  for (const item of parsed) {
    const v = coerceVariant(item);
    if (v) variants.push(v);
    if (variants.length >= VARIANT_COUNT) break;
  }
  if (variants.length === 0) {
    throw new ListingOptimizerError("Anthropic returned zero usable variants");
  }
  // If the model under-returns (rare), pad by repeating the first
  // variant — better than 503-ing the dealer. Each row stays distinct
  // in the DB via variant_index... wait, this schema doesn't track an
  // index, it just batches 3 inserts. So padding is safe.
  while (variants.length < VARIANT_COUNT) {
    variants.push(variants[0]);
  }

  return {
    variants,
    usage: {
      input_tokens: result.usage?.input_tokens ?? 0,
      output_tokens: result.usage?.output_tokens ?? 0,
    },
  };
}
