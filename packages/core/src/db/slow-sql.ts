// Interim diagnostics (#693): bun:sqlite is synchronous, so a slow statement blocks the whole
// event loop. With TURNTABLE_SLOW_SQL_MS set, every statement prepared on the handle (drizzle's
// path), and every raw run or query, is timed, and one taking at least that long is logged with
// its SQL text. The text is the parameterized statement only: bound values never appear.
import type { Database } from "bun:sqlite";
import { statSync } from "node:fs";

const METHODS = ["all", "get", "run", "values", "iterate"] as const;

/** The threshold from the environment, or undefined when off. A bad value throws at boot. */
export function slowSqlMsFromEnv(
  env: Record<string, string | undefined> = process.env,
): number | undefined {
  const raw = env.TURNTABLE_SLOW_SQL_MS?.trim();
  if (!raw) return undefined;
  const n = Number(raw);
  if (!Number.isInteger(n) || n < 10 || n > 600_000)
    throw new Error("TURNTABLE_SLOW_SQL_MS must be a whole number from 10 to 600000");
  return n;
}

/** One line for a slow statement: duration, then the SQL folded to one line and capped. */
export function slowSqlLine(ms: number, sql: string): string {
  return `[turntable] slow sql ${Math.round(ms)} ms: ${sql.replace(/\s+/g, " ").trim().slice(0, 200)}`;
}

type Stmt = Record<string, unknown>;

/** Wraps a statement's execution methods with a timer. */
function timeStatement<T extends object>(
  st: T,
  sql: string,
  ms: number,
  log: (m: string) => void,
): T {
  const s = st as unknown as Stmt;
  for (const m of METHODS) {
    const f = s[m];
    if (typeof f !== "function") continue;
    const bound = (f as (...a: unknown[]) => unknown).bind(st);
    s[m] = (...args: unknown[]) => {
      const t0 = performance.now();
      try {
        return bound(...args);
      } finally {
        const d = performance.now() - t0;
        if (d >= ms) log(slowSqlLine(d, sql));
      }
    };
  }
  return st;
}

/** Instruments a handle in place. Returns it for chaining. */
export function instrumentSlowSql(
  sqlite: Database,
  ms: number,
  log: (m: string) => void = (m) => console.error(m),
): Database {
  const db = sqlite as unknown as Record<string, unknown>;
  for (const name of ["prepare", "query"] as const) {
    const orig = (db[name] as (sql: string, ...r: unknown[]) => object).bind(sqlite);
    db[name] = (sql: string, ...rest: unknown[]) => timeStatement(orig(sql, ...rest), sql, ms, log);
  }
  const run = (db.run as (sql: string, ...r: unknown[]) => unknown).bind(sqlite);
  db.run = (sql: string, ...rest: unknown[]) => {
    const t0 = performance.now();
    try {
      return run(sql, ...rest);
    } finally {
      const d = performance.now() - t0;
      if (d >= ms) log(slowSqlLine(d, sql));
    }
  };
  return sqlite;
}

/**
 * One boot line about the database file (#693): journal mode, synchronous level, the database's
 * size and its write-ahead log's size. A large WAL that never checkpoints slows every read.
 */
export function describeSqlite(sqlite: Database, path: string): string {
  const one = (q: string): unknown => {
    try {
      const row = sqlite.query(q).get() as Record<string, unknown> | null;
      return row ? Object.values(row)[0] : undefined;
    } catch {
      return undefined;
    }
  };
  const size = (p: string): string => {
    try {
      return `${Math.round(statSync(p).size / 1048576)} MiB`;
    } catch {
      return "none";
    }
  };
  return `[turntable] sqlite: journal_mode ${String(one("PRAGMA journal_mode"))}, synchronous ${String(one("PRAGMA synchronous"))}, db ${size(path)}, wal ${size(`${path}-wal`)}`;
}
