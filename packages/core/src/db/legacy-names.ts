// Data written under the product's previous name (Longshore). Kept here, apart from the rest of
// the code, because the rename script deliberately leaves this file alone.
import type { Database } from "bun:sqlite";
import { sql, type SQL } from "drizzle-orm";
import { existsSync, renameSync } from "node:fs";
import { basename, dirname, join } from "node:path";

/**
 * If `path` is `<dir>/turntable.db`, that file is missing and `<dir>/longshore.db` exists, moves
 * the old database (and its -wal and -shm files) to the new name. Returns true when it moved.
 */
export function migrateLegacyDbFiles(path: string): boolean {
  if (path === ":memory:" || basename(path) !== "turntable.db") return false;
  const dir = dirname(path);
  const legacy = join(dir, "longshore.db");
  if (existsSync(path) || !existsSync(legacy)) return false;
  for (const suffix of ["", "-wal", "-shm"]) {
    if (existsSync(legacy + suffix)) renameSync(legacy + suffix, path + suffix);
  }
  return true;
}

const BOTH =
  "both __turntable_migrations and __longshore_migrations exist: refusing to guess which one " +
  "records the applied migrations. Keep the one that is complete and drop the other.";

/**
 * Renames the old migrations table in place, so applied migrations are not run again. A database
 * that has both tables is refused: one of them is stale and only an operator can say which.
 */
export function migrateLegacyMigrationsTable(sqlite: Database): boolean {
  const has = (name: string): boolean =>
    sqlite
      .query<{ n: number }, [string]>(
        "SELECT count(*) AS n FROM sqlite_master WHERE type = 'table' AND name = ?",
      )
      .get(name)?.n === 1;
  const legacy = has("__longshore_migrations");
  if (legacy && has("__turntable_migrations")) throw new Error(BOTH);
  if (!legacy) return false;
  sqlite.run("ALTER TABLE __longshore_migrations RENAME TO __turntable_migrations");
  return true;
}

type PgExecutor = { execute: (query: SQL) => Promise<unknown> };

/** The Postgres twin of `migrateLegacyMigrationsTable`. Run inside the migration transaction. */
export async function migrateLegacyPgMigrationsTable(tx: PgExecutor): Promise<boolean> {
  const raw = (await tx.execute(
    sql`select to_regclass('__turntable_migrations') is not null as current, to_regclass('__longshore_migrations') is not null as legacy`,
  )) as { current: boolean; legacy: boolean }[] | { rows: { current: boolean; legacy: boolean }[] };
  const row = (Array.isArray(raw) ? raw : raw.rows)[0];
  if (!row?.legacy) return false;
  if (row.current) throw new Error(BOTH);
  await tx.execute(sql`alter table __longshore_migrations rename to __turntable_migrations`);
  return true;
}
