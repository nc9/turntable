// A read-only look at a database that already exists, for `turntable doctor`: it never creates a
// file or a schema and never applies a migration, so it can run next to a live server or against
// an instance that has not started yet. The returned `orm` is only for queries.
import { Database } from "bun:sqlite";
import { drizzle } from "drizzle-orm/bun-sqlite";
import { databaseUrl, DIALECT } from "./dialect";
import { openPostgresReadOnly, type PgTarget } from "./pg";
import { migrations as sqliteMigrations } from "./migrations.generated";
import { migrations as pgMigrations } from "./migrations.pg.generated";

/**
 * Opens the existing SQLite file at `path` (throws when it is not there), or the Postgres database
 * the process was pointed at. On Postgres every connection has `default_transaction_read_only = on`,
 * so a write fails with SQLSTATE 25006. `target` is for tests, which run on a schema or PGlite.
 */
export function openReadOnly(path: string, target?: PgTarget): { orm: unknown; close(): void } {
  if (DIALECT === "pg") {
    const url = databaseUrl();
    if (!url && !target) {
      throw new Error("the process runs on Postgres but no database was configured");
    }
    // Connects on the first query, so an unreachable server shows up as a failed check.
    return openPostgresReadOnly(target ?? { url: url! });
  }
  const sqlite = new Database(path, { readonly: true, strict: true });
  return { orm: drizzle(sqlite), close: () => sqlite.close() };
}

/** The migration tags this binary carries for the dialect the process runs. */
export const embeddedMigrationTags = (): string[] =>
  (DIALECT === "pg" ? pgMigrations : sqliteMigrations).map((m) => m.tag);
