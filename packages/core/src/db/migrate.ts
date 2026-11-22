import type { Database } from "bun:sqlite";
import { migrateLegacyMigrationsTable } from "./legacy-names";

export type Migration = {
  tag: string;
  when: number;
  statements: string[];
};

/**
 * Applies pending migrations in order, each inside a transaction, and records them in
 * `__longshore_migrations`. Migrations are data (see migrations.generated.ts), so this works
 * from a compiled binary. Rebuild migrations (new CHECK constraints) are supported: see below. A Postgres dialect would reuse the `Migration` shape with its own
 * runner.
 */
export function applyMigrations(sqlite: Database, migrations: Migration[]): string[] {
  migrateLegacyMigrationsTable(sqlite);
  sqlite.run(
    "CREATE TABLE IF NOT EXISTS __longshore_migrations (tag TEXT PRIMARY KEY, applied_at INTEGER NOT NULL)",
  );
  const done = new Set(
    sqlite
      .query<{ tag: string }, []>("SELECT tag FROM __longshore_migrations")
      .all()
      .map((row) => row.tag),
  );
  const applied: string[] = [];
  for (const migration of migrations.toSorted((a, b) => a.when - b.when)) {
    if (done.has(migration.tag)) continue;
    // SQLite ignores `PRAGMA foreign_keys` inside a transaction, so the table-rebuild migrations
    // drizzle-kit emits (drop and recreate a table other tables reference) would trip foreign
    // keys. Turn enforcement off around the transaction, as SQLite's own guidance says, check
    // the result before committing, and always turn it back on.
    sqlite.run("PRAGMA foreign_keys = OFF");
    try {
      sqlite.transaction(() => {
        for (const statement of migration.statements) sqlite.run(statement);
        const broken = sqlite.query("PRAGMA foreign_key_check").all();
        if (broken.length > 0) {
          throw new Error(
            `migration ${migration.tag} left ${broken.length} foreign key violation(s); rolled back`,
          );
        }
        sqlite.run("INSERT INTO __longshore_migrations (tag, applied_at) VALUES (?, ?)", [
          migration.tag,
          Date.now(),
        ]);
      })();
    } finally {
      sqlite.run("PRAGMA foreign_keys = ON");
    }
    applied.push(migration.tag);
  }
  return applied;
}
