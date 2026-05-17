// T3.2 unit tests — acquisition signal ranking layer.
//
// The SQL view does the heavy lifting (and is regression-tested by
// migration 0016's RAISE EXCEPTION block); these tests cover the
// app-side wrapper:
//   - fetchAcquisitionSignals normalises postgres numeric (string over
//     wire) to JS number
//   - default mode drops zero-demand rows from the tile
//   - includeNoDemand keeps them for the CSV
//   - CSV escapes fields containing commas / quotes / newlines per RFC 4180
//   - limit is clamped into [1, MAX_EXPORT_ROWS]
//
// We mock the supabase client at the call surface fetch needs (.from →
// .select → .order → .limit returning a thenable). No need for the
// full mock-sb-builder here — fetchAcquisitionSignals only reads.

import { describe, expect, it, vi } from "vitest";
import {
  fetchAcquisitionSignals,
  toCsv,
  MAX_EXPORT_ROWS,
  type AcquisitionSignal,
} from "../src/lib/acquisition/rank";

interface MockRow {
  make: string | null;
  model: string | null;
  demand_count: number;
  hot_count: number;
  warm_count: number;
  cold_count: number;
  inventory_count: number;
  score: string | number;
}

function makeStubSb(rows: MockRow[], error: { message: string } | null = null) {
  const limitMock = vi.fn().mockResolvedValue({ data: rows, error });
  const orderMock = vi.fn().mockReturnValue({ limit: limitMock });
  const selectMock = vi.fn().mockReturnValue({ order: orderMock });
  const fromMock = vi.fn().mockReturnValue({ select: selectMock });
  return {
    sb: { from: fromMock } as unknown as Parameters<typeof fetchAcquisitionSignals>[0]["sb"],
    spies: { fromMock, selectMock, orderMock, limitMock },
  };
}

describe("fetchAcquisitionSignals", () => {
  it("normalises postgres numeric score (string) to JS number", async () => {
    const { sb } = makeStubSb([
      {
        make: "toyota",
        model: "camry",
        demand_count: 3,
        hot_count: 1,
        warm_count: 1,
        cold_count: 1,
        inventory_count: 0,
        score: "4.500", // postgres numeric over the wire
      },
    ]);
    const { signals, error } = await fetchAcquisitionSignals({ sb, limit: 10 });
    expect(error).toBeNull();
    expect(signals).toHaveLength(1);
    expect(signals[0].score).toBe(4.5);
    expect(typeof signals[0].score).toBe("number");
  });

  it("drops zero-demand rows from the default (tile) view", async () => {
    const { sb } = makeStubSb([
      { make: "honda", model: "civic", demand_count: 2, hot_count: 0, warm_count: 1, cold_count: 1, inventory_count: 0, score: "2.5" },
      { make: "nissan", model: "altima", demand_count: 0, hot_count: 0, warm_count: 0, cold_count: 0, inventory_count: 8, score: "0" },
    ]);
    const { signals } = await fetchAcquisitionSignals({ sb, limit: 10 });
    expect(signals.map((s) => s.model)).toEqual(["civic"]);
  });

  it("keeps zero-demand rows when includeNoDemand=true (CSV path)", async () => {
    const { sb } = makeStubSb([
      { make: "honda", model: "civic", demand_count: 2, hot_count: 0, warm_count: 1, cold_count: 1, inventory_count: 0, score: "2.5" },
      { make: "nissan", model: "altima", demand_count: 0, hot_count: 0, warm_count: 0, cold_count: 0, inventory_count: 8, score: "0" },
    ]);
    const { signals } = await fetchAcquisitionSignals({ sb, limit: 10, includeNoDemand: true });
    expect(signals.map((s) => s.model)).toEqual(["civic", "altima"]);
  });

  it("clamps limit into [1, MAX_EXPORT_ROWS]", async () => {
    const { sb, spies } = makeStubSb([]);
    await fetchAcquisitionSignals({ sb, limit: 0 });
    expect(spies.limitMock).toHaveBeenLastCalledWith(1);

    await fetchAcquisitionSignals({ sb, limit: MAX_EXPORT_ROWS + 999 });
    expect(spies.limitMock).toHaveBeenLastCalledWith(MAX_EXPORT_ROWS);

    await fetchAcquisitionSignals({ sb, limit: 25 });
    expect(spies.limitMock).toHaveBeenLastCalledWith(25);
  });

  it("returns error string when supabase errors out", async () => {
    const { sb } = makeStubSb([], { message: "RLS denied" });
    const { signals, error } = await fetchAcquisitionSignals({ sb, limit: 10 });
    expect(error).toBe("RLS denied");
    expect(signals).toEqual([]);
  });
});

describe("toCsv", () => {
  it("emits header and a row per signal", () => {
    const signals: AcquisitionSignal[] = [
      { make: "toyota", model: "camry", demand_count: 3, hot_count: 1, warm_count: 1, cold_count: 1, inventory_count: 0, score: 4.5 },
    ];
    const csv = toCsv(signals);
    expect(csv).toContain("make,model,demand_count,hot_count,warm_count,cold_count,inventory_count,score\n");
    expect(csv).toContain("toyota,camry,3,1,1,1,0,4.500\n");
  });

  it("escapes fields containing commas, quotes, or newlines (RFC 4180)", () => {
    const signals: AcquisitionSignal[] = [
      { make: "ford", model: 'f-150, supercrew', demand_count: 1, hot_count: 0, warm_count: 0, cold_count: 1, inventory_count: 0, score: 1.0 },
      { make: 'with"quote', model: "x", demand_count: 1, hot_count: 0, warm_count: 0, cold_count: 1, inventory_count: 0, score: 1.0 },
    ];
    const csv = toCsv(signals);
    // Comma in field → wrapped in quotes.
    expect(csv).toContain('"f-150, supercrew"');
    // Quote in field → doubled + wrapped.
    expect(csv).toContain('"with""quote"');
  });

  it("trailing newline so the file ends cleanly for `cat`/Excel", () => {
    const csv = toCsv([]);
    expect(csv.endsWith("\n")).toBe(true);
  });
});
