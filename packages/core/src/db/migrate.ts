import type { Database } from "bun:sqlite";
import { migrateLegacyMigrationsTable } from "./legacy-names";
import { checkMigrationShas, migrationSha } from "./migration-sha";

export type Migration = {
  tag: string;
  when: number;
  statements: string[];
};

/**
 * Applies pending migrations in order, each inside a transaction, and records them, with the sha256 of their SQL, in
 * `__turntable_migrations`. An applied migration whose SQL has since changed refuses the boot. Migrations are data (see migrations.generated.ts), so this works
 * from a compiled binary. Rebuild migrations (new CHECK constraints) are supported: see below. A Postgres dialect would reuse the `Migration` shape with its own
 * runner.
 */
export function applyMigrations(sqlite: Database, migrations: Migration[]): string[] {
  migrateLegacyMigrationsTable(sqlite);
  // `sha256` was added after the table: an older table gets the column, its rows are stamped below.
  // One IMMEDIATE transaction, so two processes booting together do not both see the column
  // missing and then both add it.
  sqlite
    .transaction(() => {
      sqlite.run(
        "CREATE TABLE IF NOT EXISTS __turntable_migrations (tag TEXT PRIMARY KEY, applied_at INTEGER NOT NULL)",
      );
      const columns = sqlite
        .query<{ name: string }, []>("PRAGMA table_info(__turntable_migrations)")
        .all();
      if (!columns.some((c) => c.name === "sha256")) {
        sqlite.run("ALTER TABLE __turntable_migrations ADD COLUMN sha256 TEXT");
      }
    })
    .immediate();
  const recorded = new Map(
    sqlite
      .query<{ tag: string; sha256: string | null }, []>(
        "SELECT tag, sha256 FROM __turntable_migrations",
      )
      .all()
      .map((row) => [row.tag, row.sha256] as const),
  );
  // Refuse before anything runs if an applied migration's SQL changed since it was applied.
  for (const row of checkMigrationShas(recorded, migrations)) {
    sqlite.run("UPDATE __turntable_migrations SET sha256 = ? WHERE tag = ?", [row.sha, row.tag]);
  }
  const done = new Set(recorded.keys());
  const applied: string[] = [];
  for (const migration of migrations.toSorted((a, b) => a.when - b.when)) {
    if (done.has(migration.tag)) continue;
    // SQLite ignores `PRAGMA foreign_keys` inside a transaction, so the table-rebuild migrations
    // drizzle-kit emits (drop and recreate a table other tables reference) would trip foreign
    // keys. Turn enforcement off around the transaction, as SQLite's own guidance says, check
    // the result before committing, and always turn it back on.
    sqlite.run("PRAGMA foreign_keys = OFF");
    try {
      // IMMEDIATE: the write lock is taken at the start, where the busy timeout applies. A deferred
      // transaction that reads first and writes later can be refused at once when another
      // connection wrote in between.
      sqlite
        .transaction(() => {
          for (const statement of migration.statements) sqlite.run(statement);
          const broken = sqlite.query("PRAGMA foreign_key_check").all();
          if (broken.length > 0) {
            throw new Error(
              `migration ${migration.tag} left ${broken.length} foreign key violation(s); rolled back`,
            );
          }
          sqlite.run(
            "INSERT INTO __turntable_migrations (tag, applied_at, sha256) VALUES (?, ?, ?)",
            [migration.tag, Date.now(), migrationSha(migration)],
          );
        })
        .immediate();
    } finally {
      sqlite.run("PRAGMA foreign_keys = ON");
    }
    applied.push(migration.tag);
  }
  return applied;
}
