import type { Database } from "bun:sqlite";

export type Migration = {
  tag: string;
  when: number;
  statements: string[];
};

/**
 * Applies pending migrations in order, each inside a transaction, and records them in
 * `__turntable_migrations`. Migrations are data (see migrations.generated.ts), so this works
 * from a compiled binary. A Postgres dialect would reuse the `Migration` shape with its own
 * runner.
 */
export function applyMigrations(sqlite: Database, migrations: Migration[]): string[] {
  sqlite.run(
    "CREATE TABLE IF NOT EXISTS __turntable_migrations (tag TEXT PRIMARY KEY, applied_at INTEGER NOT NULL)",
  );
  const done = new Set(
    sqlite
      .query<{ tag: string }, []>("SELECT tag FROM __turntable_migrations")
      .all()
      .map((row) => row.tag),
  );
  const applied: string[] = [];
  for (const migration of migrations.toSorted((a, b) => a.when - b.when)) {
    if (done.has(migration.tag)) continue;
    sqlite.transaction(() => {
      for (const statement of migration.statements) sqlite.run(statement);
      sqlite.run("INSERT INTO __turntable_migrations (tag, applied_at) VALUES (?, ?)", [
        migration.tag,
        Date.now(),
      ]);
    })();
    applied.push(migration.tag);
  }
  return applied;
}
