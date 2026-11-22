// Data written under the product's previous name (Turntable). Kept here, apart from the rest of
// the code, because the rename script deliberately leaves this file alone.
import type { Database } from "bun:sqlite";
import { existsSync, renameSync } from "node:fs";
import { basename, dirname, join } from "node:path";

/**
 * If `path` is `<dir>/longshore.db`, that file is missing and `<dir>/turntable.db` exists, moves
 * the old database (and its -wal and -shm files) to the new name. Returns true when it moved.
 */
export function migrateLegacyDbFiles(path: string): boolean {
  if (path === ":memory:" || basename(path) !== "longshore.db") return false;
  const dir = dirname(path);
  const legacy = join(dir, "turntable.db");
  if (existsSync(path) || !existsSync(legacy)) return false;
  for (const suffix of ["", "-wal", "-shm"]) {
    if (existsSync(legacy + suffix)) renameSync(legacy + suffix, path + suffix);
  }
  return true;
}

/** Renames the old migrations table in place, so applied migrations are not run again. */
export function migrateLegacyMigrationsTable(sqlite: Database): boolean {
  const has = (name: string): boolean =>
    sqlite
      .query<{ n: number }, [string]>(
        "SELECT count(*) AS n FROM sqlite_master WHERE type = 'table' AND name = ?",
      )
      .get(name)?.n === 1;
  if (has("__turntable_migrations") && !has("__longshore_migrations")) {
    sqlite.run("ALTER TABLE __turntable_migrations RENAME TO __longshore_migrations");
    return true;
  }
  return false;
}
