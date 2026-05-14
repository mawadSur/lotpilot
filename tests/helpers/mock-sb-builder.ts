// Query-builder shim for the in-process Supabase mock. Mirrors the
// chainable surface of the real PostgrestQueryBuilder used by
// chat-pipeline.ts (+ conversation-router.ts + consent-capture.ts).
//
// Split out of mock-pipeline.ts so each file stays under the 500-line
// project cap. mock-pipeline.ts owns the seed/store API + the
// `makeMockSb` Proxy that wires these classes together.

export type Filter = (row: Record<string, unknown>) => boolean;
type Sorter = (a: Record<string, unknown>, b: Record<string, unknown>) => number;

export interface BuilderResult<T> {
  data: T;
  error: { message: string; code?: string } | null;
  count?: number;
}

interface BuilderState {
  table: string;
  filters: Filter[];
  selectColumns: string | null;
  orderBy: Sorter | null;
  limitN: number | null;
  countMode: "exact" | null;
  headOnly: boolean;
}

// Resolver: maps a table name to a backing Map. The mock-pipeline owns
// the actual store and passes a resolver down so each test gets a
// fresh store without circular imports.
export type TableResolver = (name: string) => Map<string, Record<string, unknown>>;
export type IdMinter = () => string;

// Simple "or" parser tailored to the only or() string chat-pipeline uses:
//   "role.eq.buyer,and(role.in.(ai,dealer),approval_status.in.(approved,auto,sent))"
// We don't need a full PostgREST parser — just enough for that one case.
function buildOrFilter(expr: string): Filter {
  const parts = splitTopLevel(expr, ",");
  const subFilters: Filter[] = parts.map((part) => {
    const trimmed = part.trim();
    if (trimmed.startsWith("and(") && trimmed.endsWith(")")) {
      const inner = trimmed.slice(4, -1);
      const innerParts = splitTopLevel(inner, ",");
      const innerFilters = innerParts.map(parseSimpleClause);
      return (row) => innerFilters.every((f) => f(row));
    }
    return parseSimpleClause(trimmed);
  });
  return (row) => subFilters.some((f) => f(row));
}

function splitTopLevel(expr: string, delim: string): string[] {
  const out: string[] = [];
  let depth = 0;
  let buf = "";
  for (const ch of expr) {
    if (ch === "(") depth += 1;
    if (ch === ")") depth -= 1;
    if (ch === delim && depth === 0) {
      out.push(buf);
      buf = "";
    } else {
      buf += ch;
    }
  }
  if (buf) out.push(buf);
  return out;
}

function parseSimpleClause(clause: string): Filter {
  const trimmed = clause.trim();
  const eqMatch = /^([A-Za-z_][A-Za-z0-9_]*)\.eq\.(.+)$/.exec(trimmed);
  if (eqMatch) {
    const [, col, raw] = eqMatch;
    return (row) => row[col] === raw;
  }
  const inMatch = /^([A-Za-z_][A-Za-z0-9_]*)\.in\.\((.+)\)$/.exec(trimmed);
  if (inMatch) {
    const [, col, list] = inMatch;
    const values = list.split(",").map((s) => s.trim());
    return (row) => values.includes(String(row[col]));
  }
  return () => false;
}

export class QueryBuilder {
  private readonly state: BuilderState;

  constructor(
    table: string,
    private readonly tableMap: TableResolver,
  ) {
    this.state = {
      table,
      filters: [],
      selectColumns: null,
      orderBy: null,
      limitN: null,
      countMode: null,
      headOnly: false,
    };
  }

  select(columns?: string, opts?: { count?: "exact"; head?: boolean }): this {
    this.state.selectColumns = columns ?? "*";
    if (opts?.count === "exact") this.state.countMode = "exact";
    if (opts?.head) this.state.headOnly = true;
    return this;
  }

  eq(col: string, val: unknown): this {
    this.state.filters.push((row) => row[col] === val);
    return this;
  }

  in(col: string, values: unknown[]): this {
    this.state.filters.push((row) => values.includes(row[col] as unknown));
    return this;
  }

  not(col: string, op: "is", val: unknown): this {
    if (op === "is" && val === null) {
      this.state.filters.push((row) => row[col] !== null && row[col] !== undefined);
    }
    return this;
  }

  gt(col: string, val: string): this {
    this.state.filters.push((row) => String(row[col]) > val);
    return this;
  }

  ilike(col: string, pattern: string): this {
    // Translate SQL ILIKE %x% to a case-insensitive substring match.
    // Only supports leading + trailing % in v0.5; that's all we use.
    const trimmed = pattern.replace(/^%/, "").replace(/%$/, "").toLowerCase();
    this.state.filters.push((row) => {
      const v = row[col];
      return typeof v === "string" && v.toLowerCase().includes(trimmed);
    });
    return this;
  }

  or(expr: string): this {
    this.state.filters.push(buildOrFilter(expr));
    return this;
  }

  order(col: string, opts: { ascending: boolean }): this {
    this.state.orderBy = (a, b) => {
      const av = String(a[col] ?? "");
      const bv = String(b[col] ?? "");
      if (av === bv) return 0;
      return (av < bv ? -1 : 1) * (opts.ascending ? 1 : -1);
    };
    return this;
  }

  limit(n: number): this {
    this.state.limitN = n;
    return this;
  }

  private resolveRows(): Record<string, unknown>[] {
    const all = [...this.tableMap(this.state.table).values()];
    let rows = all.filter((row) => this.state.filters.every((f) => f(row)));
    if (this.state.orderBy) rows = rows.slice().sort(this.state.orderBy);
    if (this.state.limitN != null) rows = rows.slice(0, this.state.limitN);
    return rows;
  }

  then<TResult1 = BuilderResult<Record<string, unknown>[]>, TResult2 = never>(
    onfulfilled?:
      | ((value: BuilderResult<Record<string, unknown>[]>) => TResult1 | PromiseLike<TResult1>)
      | null,
    onrejected?: ((reason: unknown) => TResult2 | PromiseLike<TResult2>) | null,
  ): Promise<TResult1 | TResult2> {
    const rows = this.resolveRows();
    const all = [...this.tableMap(this.state.table).values()].filter((row) =>
      this.state.filters.every((f) => f(row)),
    );
    const result: BuilderResult<Record<string, unknown>[]> = {
      data: this.state.headOnly ? [] : rows,
      error: null,
      count: this.state.countMode ? all.length : undefined,
    };
    return Promise.resolve(result).then(onfulfilled ?? null, onrejected ?? null);
  }

  async maybeSingle(): Promise<BuilderResult<Record<string, unknown> | null>> {
    const rows = this.resolveRows();
    if (rows.length === 0) return { data: null, error: null };
    if (rows.length > 1) {
      return { data: null, error: { message: "multiple rows returned", code: "PGRST116" } };
    }
    return { data: rows[0], error: null };
  }

  async single(): Promise<BuilderResult<Record<string, unknown> | null>> {
    const rows = this.resolveRows();
    if (rows.length === 0) {
      return { data: null, error: { message: "no rows returned", code: "PGRST116" } };
    }
    return { data: rows[0], error: null };
  }
}

export class InsertBuilder {
  constructor(
    private readonly table: string,
    private readonly rows: Record<string, unknown>[],
    private readonly tableMap: TableResolver,
    private readonly mintId: IdMinter,
  ) {}

  private commit(): Record<string, unknown>[] {
    const inserted: Record<string, unknown>[] = [];
    for (const row of this.rows) {
      const id = (row.id as string | undefined) ?? this.mintId();
      const now = new Date().toISOString();
      const full = {
        ...row,
        id,
        created_at: row.created_at ?? now,
        updated_at: row.updated_at ?? now,
      };
      this.tableMap(this.table).set(id, full);
      inserted.push(full);
    }
    return inserted;
  }

  then<TResult1 = BuilderResult<Record<string, unknown>[]>, TResult2 = never>(
    onfulfilled?:
      | ((value: BuilderResult<Record<string, unknown>[]>) => TResult1 | PromiseLike<TResult1>)
      | null,
    onrejected?: ((reason: unknown) => TResult2 | PromiseLike<TResult2>) | null,
  ): Promise<TResult1 | TResult2> {
    const inserted = this.commit();
    const result: BuilderResult<Record<string, unknown>[]> = { data: inserted, error: null };
    return Promise.resolve(result).then(onfulfilled ?? null, onrejected ?? null);
  }

  select(): InsertSelectBuilder {
    const inserted = this.commit();
    return new InsertSelectBuilder(inserted);
  }
}

export class InsertSelectBuilder {
  constructor(private readonly inserted: Record<string, unknown>[]) {}

  async single(): Promise<BuilderResult<Record<string, unknown> | null>> {
    if (this.inserted.length === 0) {
      return { data: null, error: { message: "no rows inserted" } };
    }
    return { data: this.inserted[0], error: null };
  }
}

export class UpdateBuilder {
  private readonly filters: Filter[] = [];

  constructor(
    private readonly table: string,
    private readonly patch: Record<string, unknown>,
    private readonly tableMap: TableResolver,
  ) {}

  eq(col: string, val: unknown): this {
    this.filters.push((row) => row[col] === val);
    return this;
  }

  private commit(): Record<string, unknown>[] {
    const out: Record<string, unknown>[] = [];
    const map = this.tableMap(this.table);
    for (const [id, row] of map.entries()) {
      if (!this.filters.every((f) => f(row))) continue;
      const updated = { ...row, ...this.patch, updated_at: new Date().toISOString() };
      map.set(id, updated);
      out.push(updated);
    }
    return out;
  }

  then<TResult1 = BuilderResult<Record<string, unknown>[]>, TResult2 = never>(
    onfulfilled?:
      | ((value: BuilderResult<Record<string, unknown>[]>) => TResult1 | PromiseLike<TResult1>)
      | null,
    onrejected?: ((reason: unknown) => TResult2 | PromiseLike<TResult2>) | null,
  ): Promise<TResult1 | TResult2> {
    const updated = this.commit();
    return Promise.resolve({ data: updated, error: null }).then(
      onfulfilled ?? null,
      onrejected ?? null,
    );
  }

  select(): { single(): Promise<BuilderResult<Record<string, unknown> | null>> } {
    const updated = this.commit();
    return {
      async single() {
        if (updated.length === 0) return { data: null, error: { message: "no rows updated" } };
        return { data: updated[0], error: null };
      },
    };
  }
}
