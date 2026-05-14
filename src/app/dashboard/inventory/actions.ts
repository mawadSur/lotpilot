"use server";

import { revalidatePath } from "next/cache";
import { requireDealer } from "@/lib/auth";
import { createServiceSupabase } from "@/lib/supabase-service";
import { CsvTooLargeError, parseCsv } from "@/lib/csv";
import { log } from "@/lib/log";
import type { VehicleStatus } from "@/lib/db-types";

// MIME-type fallbacks: Excel sometimes labels CSVs with the spreadsheet
// type, and Safari occasionally sends an empty / octet-stream type for
// drag-and-drop files.
const ACCEPTED_CSV_MIME: ReadonlySet<string> = new Set([
  "text/csv",
  "application/csv",
  "application/vnd.ms-excel",
  "application/octet-stream",
  "",
]);

export interface UploadError {
  row: number; // 1-indexed, header is row 1
  reason: string;
}

export interface UploadResult {
  inserted: number;
  updated: number;
  errors: UploadError[];
  totalRows: number;
}

export type UploadState =
  | { status: "idle" }
  | { status: "ok"; result: UploadResult }
  | { status: "error"; message: string };

const MAX_ROWS = 5000;
const VALID_STATUSES: ReadonlySet<VehicleStatus> = new Set([
  "available",
  "pending",
  "sold",
  "hidden",
]);

function priceToCents(raw: string): number | null {
  const trimmed = raw.trim();
  if (!trimmed) return null;
  const cleaned = trimmed.replace(/[^0-9.]/g, "");
  if (!cleaned) return null;
  const n = Number(cleaned);
  if (!Number.isFinite(n) || n < 0) return null;
  // Treat values with a decimal as dollar.cents; otherwise plain dollars.
  const cents = cleaned.includes(".") ? Math.round(n * 100) : Math.round(n) * 100;
  if (cents > 100_000_000) return null;
  return cents;
}

function intOrNull(raw: string, max: number): number | null {
  const trimmed = raw.trim();
  if (!trimmed) return null;
  const cleaned = trimmed.replace(/[^0-9]/g, "");
  if (!cleaned) return null;
  const n = Number(cleaned);
  if (!Number.isInteger(n) || n < 0 || n > max) return null;
  return n;
}

function strOrNull(raw: string, max: number): string | null {
  const trimmed = raw.trim();
  if (!trimmed) return null;
  return trimmed.slice(0, max);
}

export async function uploadInventoryCsv(
  _prev: UploadState,
  formData: FormData,
): Promise<UploadState> {
  const { dealer } = await requireDealer();

  const fileRaw = formData.get("file");
  if (!(fileRaw instanceof File) || fileRaw.size === 0) {
    return { status: "error", message: "Pick a .csv file." };
  }
  const validExt = fileRaw.name.toLowerCase().endsWith(".csv");
  const validType = ACCEPTED_CSV_MIME.has(fileRaw.type);
  if (!validExt || !validType) {
    return { status: "error", message: "Pick a .csv file." };
  }
  if (fileRaw.size > 5 * 1024 * 1024) {
    return { status: "error", message: "CSV is too large (max 5 MB)." };
  }

  const text = await fileRaw.text();
  let rows;
  try {
    rows = parseCsv(text);
  } catch (err) {
    if (err instanceof CsvTooLargeError) {
      return {
        status: "error",
        message: `CSV has too many rows (max ${MAX_ROWS} per upload).`,
      };
    }
    throw err;
  }
  if (rows.length === 0) {
    return { status: "error", message: "CSV had no data rows." };
  }
  if (rows.length > MAX_ROWS) {
    return {
      status: "error",
      message: `CSV has ${rows.length} rows; the maximum is ${MAX_ROWS} per upload.`,
    };
  }

  const errors: UploadError[] = [];
  const inserts: {
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
  }[] = [];

  rows.forEach((row, idx) => {
    const rowNum = idx + 2; // +1 for 0-index, +1 for header.
    const stock = (row.stock_number ?? "").trim();
    if (!stock) {
      errors.push({ row: rowNum, reason: "Missing stock_number." });
      return;
    }
    if (stock.length > 60) {
      errors.push({ row: rowNum, reason: "stock_number is longer than 60 chars." });
      return;
    }

    const vin = strOrNull(row.vin ?? "", 17);
    if (vin && (vin.length < 11 || vin.length > 17)) {
      errors.push({ row: rowNum, reason: "VIN must be 11–17 characters." });
      return;
    }

    const year = intOrNull(row.year ?? "", 2100);
    if (row.year && (year === null || year < 1950)) {
      errors.push({ row: rowNum, reason: "year must be 1950–2100." });
      return;
    }

    const mileage = intOrNull(row.mileage ?? "", 1_000_000);
    if (row.mileage && mileage === null) {
      errors.push({ row: rowNum, reason: "mileage must be a non-negative integer." });
      return;
    }

    const price_cents = priceToCents(row.price ?? "");
    if (row.price && price_cents === null) {
      errors.push({ row: rowNum, reason: "price could not be parsed." });
      return;
    }

    const statusRaw = (row.status ?? "available").trim().toLowerCase();
    if (!VALID_STATUSES.has(statusRaw as VehicleStatus)) {
      errors.push({ row: rowNum, reason: `status must be one of available/pending/sold/hidden.` });
      return;
    }

    inserts.push({
      dealer_id: dealer.id,
      stock_number: stock,
      vin,
      year,
      make: strOrNull(row.make ?? "", 60),
      model: strOrNull(row.model ?? "", 80),
      trim: strOrNull(row.trim ?? "", 80),
      mileage,
      price_cents,
      photo_url: strOrNull(row.photo_url ?? "", 2048),
      description: strOrNull(row.description ?? "", 4000),
      status: statusRaw as VehicleStatus,
    });
  });

  if (inserts.length === 0) {
    return {
      status: "ok",
      result: { inserted: 0, updated: 0, errors, totalRows: rows.length },
    };
  }

  const sb = createServiceSupabase();

  // Identify which stock_numbers already exist so we can report inserted vs.
  // updated counts. We use upsert on (dealer_id, stock_number) regardless.
  const existingRes = await sb
    .from("vehicles")
    .select("stock_number")
    .eq("dealer_id", dealer.id)
    .in("stock_number", inserts.map((v) => v.stock_number));

  const existing = new Set(
    (existingRes.data ?? []).map((r) => (r as { stock_number: string }).stock_number),
  );

  let inserted = 0;
  let updated = 0;
  for (const v of inserts) {
    if (existing.has(v.stock_number)) updated += 1;
    else inserted += 1;
  }

  // Chunked upsert. Raw error.message is logger-only — buyer-facing
  // surface is the generic message below.
  const CHUNK = 500;
  for (let i = 0; i < inserts.length; i += CHUNK) {
    const slice = inserts.slice(i, i + CHUNK);
    const { error } = await sb
      .from("vehicles")
      .upsert(slice, { onConflict: "dealer_id,stock_number" });
    if (error) {
      log.error("inventory.upsert_failed", {
        dealer_id: dealer.id,
        chunk_start: i + 2,
        chunk_end: i + slice.length + 1,
        code: error.code,
        detail: error.message,
      });
      return {
        status: "error",
        message: "Could not save inventory. Try again or contact support if this keeps happening.",
      };
    }
  }

  revalidatePath("/dashboard/inventory");
  return {
    status: "ok",
    result: { inserted, updated, errors, totalRows: rows.length },
  };
}
